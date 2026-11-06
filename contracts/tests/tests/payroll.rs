//! Payroll on a sandbox node (SPEC §7.3): admin onboarding (R15) and the wage cap (R4).

use homeroll_common::errors::{
    ERR_ABOVE_WAGE_CAP, ERR_BELOW_BUFFER, ERR_EMPLOYER_EXISTS, ERR_NOT_ADMIN, ERR_NOT_EMPLOYER,
    ERR_RUN_COMPLETE, ERR_RUN_NOT_FOUND, ERR_TOO_MANY_PAYEES, ERR_UNKNOWN_PAYEE, line_error,
};
use homeroll_contract_tests::{Contract, Env, assert_fails_with};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken};
use serde_json::{Value, json};
use testresult::TestResult;

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// 500 tUSDC in base units (6 decimals). Synthetic.
const CAP: u128 = 500_000_000;

fn token_account(root: &AccountId) -> AccountId {
    Contract::Tusdc.account_id(root)
}

async fn deploy_payroll(env: &Env) -> TestResult<AccountId> {
    env.deploy(
        Contract::Payroll,
        json!({ "admin": env.root, "token": token_account(&env.root) }),
    )
    .await
}

/// Payroll on `payroll.<root>`, one employer onboarded with no buffer, one payee at CAP.
/// The payee account need not exist: nothing is transferred in this unit.
async fn employer_with_one_payee() -> TestResult<(Env, AccountId, AccountId, AccountId)> {
    let env = Env::start().await?;
    let payroll = deploy_payroll(&env).await?;
    let employer = env.create_user("perabotjaya").await?;
    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": employer, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let worker: AccountId = format!("w-7k2q9x.{}", env.root).parse()?;
    env.call(
        &employer,
        &payroll,
        "add_payee",
        json!({ "account_id": worker, "cap": CAP.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    Ok((env, payroll, employer, worker))
}

async fn submit_one_line(
    env: &Env,
    payroll: &AccountId,
    employer: &AccountId,
    worker: &AccountId,
    amount: u128,
) -> TestResult<(String, TransactionResult)> {
    let period = env.open_period().await?;
    let lines = json!([{ "account_id": worker, "amount": amount.to_string() }]);
    let outcome = env
        .call(
            employer,
            payroll,
            "submit_run",
            json!({ "period": period, "lines": lines }),
            NO_DEPOSIT,
        )
        .await?;
    Ok((period, outcome))
}

/// R4, and ADR-0001: the failing run leaves no trace.
#[tokio::test]
async fn a_line_one_above_the_wage_cap_fails_and_stores_no_run() -> TestResult {
    let (env, payroll, employer, worker) = employer_with_one_payee().await?;

    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, CAP + 1).await?;

    assert_fails_with(outcome, &line_error(ERR_ABOVE_WAGE_CAP, 0, worker.as_str()));
    // `[]`, not `null`: the employer exists and has no run for the period.
    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs, json!([]));
    // Step 8 never ran: nothing reserved, onboarding not ended.
    let state = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(
        state,
        json!({ "treasury": "0", "buffer": "0", "onboarding": true, "payee_count": 1 })
    );
    Ok(())
}

/// The cap is inclusive. Checks 1–4 pass, and with no way to fund the treasury the run stops at check 7.
#[tokio::test]
async fn a_line_at_the_wage_cap_passes_r4_and_stops_at_the_empty_treasury() -> TestResult {
    let (env, payroll, employer, worker) = employer_with_one_payee().await?;

    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, CAP).await?;

    assert_fails_with(outcome, ERR_BELOW_BUFFER);
    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs, json!([]));
    Ok(())
}

/// R15: only the Homeroll admin onboards employers (ADR-0002).
#[tokio::test]
async fn only_the_admin_registers_employers() -> TestResult {
    let env = Env::start().await?;
    let payroll = deploy_payroll(&env).await?;
    let stranger = env.create_user("stranger").await?;

    let outcome = env
        .call(
            &stranger,
            &payroll,
            "register_employer",
            json!({ "employer": stranger, "buffer": "0" }),
            NO_DEPOSIT,
        )
        .await?;

    assert_fails_with(outcome, ERR_NOT_ADMIN);
    let state = env
        .view(&payroll, "get_employer", json!({ "employer": stranger }))
        .await?;
    assert_eq!(state, Value::Null, "an unknown employer reads as null");
    Ok(())
}

#[tokio::test]
async fn an_employer_is_registered_once() -> TestResult {
    let (env, payroll, employer, _) = employer_with_one_payee().await?;
    let outcome = env
        .call(
            &env.root,
            &payroll,
            "register_employer",
            json!({ "employer": employer, "buffer": "0" }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_EMPLOYER_EXISTS);
    Ok(())
}

/// R15: the 41st payee is over the demo floor, and the count stays 40.
#[tokio::test]
async fn the_41st_payee_is_rejected_and_the_count_stays_at_40() -> TestResult {
    let env = Env::start().await?;
    let payroll = deploy_payroll(&env).await?;
    let employer = env.create_user("perabotjaya").await?;
    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": employer, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    for index in 0..40 {
        let account: AccountId = format!("w-{index:06x}.{}", env.root).parse()?;
        env.call(
            &employer,
            &payroll,
            "add_payee",
            json!({ "account_id": account, "cap": CAP.to_string() }),
            NO_DEPOSIT,
        )
        .await?
        .assert_success();
    }
    let extra: AccountId = format!("w-{:06x}.{}", 40, env.root).parse()?;
    let outcome = env
        .call(
            &employer,
            &payroll,
            "add_payee",
            json!({ "account_id": extra, "cap": CAP.to_string() }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_TOO_MANY_PAYEES);
    let state = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(state["payee_count"], json!(40));
    Ok(())
}

/// `null` means no such employer. `[]` means the employer exists and has no runs.
#[tokio::test]
async fn views_distinguish_a_missing_employer_from_an_employer_with_no_runs() -> TestResult {
    let env = Env::start().await?;
    let payroll = deploy_payroll(&env).await?;
    let period = env.open_period().await?;
    let unknown: AccountId = "nobody.sandbox".parse()?;
    assert_eq!(
        env.view(&payroll, "get_employer", json!({ "employer": unknown }))
            .await?,
        Value::Null
    );
    assert_eq!(
        env.view(
            &payroll,
            "get_runs",
            json!({ "employer": unknown, "period": period }),
        )
        .await?,
        Value::Null
    );

    let employer = env.create_user("perabotjaya").await?;
    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": employer, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    assert_eq!(
        env.view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?,
        json!([])
    );
    Ok(())
}

/// Wage-cap copy reads the payee account and cap. An unknown employer is `null`, same as `get_employer`.
#[tokio::test]
async fn get_payees_lists_payees_and_null_for_an_unknown_employer() -> TestResult {
    let (env, payroll, employer, worker) = employer_with_one_payee().await?;
    let unknown: AccountId = "nobody.sandbox".parse()?;
    assert_eq!(
        env.view(&payroll, "get_payees", json!({ "employer": unknown }))
            .await?,
        Value::Null
    );

    let payees = env
        .view(&payroll, "get_payees", json!({ "employer": employer }))
        .await?;
    let rows = payees
        .as_array()
        .expect("a registered employer returns a list");
    let row = rows
        .iter()
        .find(|row| row["account_id"] == json!(worker.as_str()))
        .expect("the payee added by the helper is listed");
    assert_eq!(row["cap"], json!(CAP.to_string()));
    let active_from = row["active_from"]
        .as_str()
        .expect("active_from is a JSON string");
    assert!(
        !active_from.is_empty() && active_from.bytes().all(|byte| byte.is_ascii_digit()),
        "active_from is a string of digits, got {active_from}"
    );
    Ok(())
}

async fn register_tusdc_storage(env: &Env, tusdc: &AccountId, account: &AccountId) -> TestResult {
    let bounds = env.view(tusdc, "storage_balance_bounds", json!({})).await?;
    let storage: NearToken = serde_json::from_value(bounds["min"].clone())?;
    env.call(account, tusdc, "storage_deposit", json!({}), storage)
        .await?
        .assert_success();
    Ok(())
}

async fn fund_treasury_via_transfer_call(
    env: &Env,
    tusdc: &AccountId,
    payroll: &AccountId,
    employer: &AccountId,
    amount: u128,
) -> TestResult {
    env.call(
        &env.root,
        tusdc,
        "mint",
        json!({ "account_id": employer, "amount": amount.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        employer,
        tusdc,
        "ft_transfer_call",
        json!({
            "receiver_id": payroll,
            "amount": amount.to_string(),
            "memo": null,
            "msg": json!({ "employer": employer }).to_string(),
        }),
        ONE_YOCTO,
    )
    .await?
    .assert_success();
    Ok(())
}

async fn payroll_payout_fixture() -> TestResult<(Env, AccountId, AccountId, AccountId, AccountId)> {
    let env = Env::start().await?;
    let tusdc = env
        .deploy(Contract::Tusdc, json!({ "admin": env.root }))
        .await?;
    let payroll = deploy_payroll(&env).await?;
    register_tusdc_storage(&env, &tusdc, &payroll).await?;
    let employer = env.create_user("perabotjaya").await?;
    register_tusdc_storage(&env, &tusdc, &employer).await?;
    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": employer, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let worker = env.create_user("payeeone").await?;
    env.call(
        &employer,
        &payroll,
        "add_payee",
        json!({ "account_id": worker, "cap": CAP.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    Ok((env, tusdc, payroll, employer, worker))
}

const PAY_AMOUNT: u128 = 100_000_000;

#[tokio::test]
async fn pay_run_pays_a_reserved_line_and_a_second_call_is_complete() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    register_tusdc_storage(&env, &tusdc, &worker).await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();

    env.call(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs[0]["lines"][0]["status"], json!("Paid"));
    let worker_balance = env
        .view(&tusdc, "ft_balance_of", json!({ "account_id": worker }))
        .await?;
    assert_eq!(worker_balance, json!(PAY_AMOUNT.to_string()));
    let treasury = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(treasury["treasury"], json!("0"));

    let again = env
        .call(
            &employer,
            &payroll,
            "pay_run",
            json!({ "run_id": 0 }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(again, ERR_RUN_COMPLETE);
    assert_eq!(
        env.view(&tusdc, "ft_balance_of", json!({ "account_id": worker }),)
            .await?,
        json!(PAY_AMOUNT.to_string())
    );
    Ok(())
}

#[tokio::test]
async fn one_pay_run_pays_two_lines() -> TestResult {
    let (env, tusdc, payroll, employer, first) = payroll_payout_fixture().await?;
    let second = env.create_user("payeetwo").await?;
    register_tusdc_storage(&env, &tusdc, &first).await?;
    register_tusdc_storage(&env, &tusdc, &second).await?;
    env.call(
        &employer,
        &payroll,
        "add_payee",
        json!({ "account_id": second, "cap": CAP.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let total = PAY_AMOUNT * 2;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, total).await?;
    let period = env.open_period().await?;
    env.call(
        &employer,
        &payroll,
        "submit_run",
        json!({
            "period": period,
            "lines": [
                { "account_id": first, "amount": PAY_AMOUNT.to_string() },
                { "account_id": second, "amount": PAY_AMOUNT.to_string() },
            ],
        }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    env.call(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs[0]["status"], json!("Done"));
    assert_eq!(runs[0]["lines"][0]["status"], json!("Paid"));
    assert_eq!(runs[0]["lines"][1]["status"], json!("Paid"));
    for worker in [&first, &second] {
        assert_eq!(
            env.view(&tusdc, "ft_balance_of", json!({ "account_id": worker }))
                .await?,
            json!(PAY_AMOUNT.to_string())
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_transfer_restores_treasury_and_pays_nothing() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();
    let payroll_tokens_before = env
        .view(&tusdc, "ft_balance_of", json!({ "account_id": payroll }))
        .await?;

    env.call(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs[0]["lines"][0]["status"], json!("Failed"));
    let treasury = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(treasury["treasury"], json!(PAY_AMOUNT.to_string()));
    let worker_balance = env
        .view(&tusdc, "ft_balance_of", json!({ "account_id": worker }))
        .await?;
    assert_eq!(worker_balance, json!("0"));
    assert_eq!(
        env.view(&tusdc, "ft_balance_of", json!({ "account_id": payroll }),)
            .await?,
        payroll_tokens_before
    );
    Ok(())
}

#[tokio::test]
async fn pay_run_skips_an_inactive_payee_and_restores_treasury() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();
    env.call(
        &employer,
        &payroll,
        "add_payee",
        json!({ "account_id": worker, "cap": CAP.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    env.call(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs[0]["lines"][0]["status"], json!("Skipped"));
    let treasury = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(treasury["treasury"], json!(PAY_AMOUNT.to_string()));
    Ok(())
}

#[tokio::test]
async fn a_worker_cannot_call_on_line_paid() -> TestResult {
    let (env, _tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    let period = env.open_period().await?;
    let runs_before = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    let outcome = env
        .call(
            &worker,
            &payroll,
            "on_line_paid",
            json!({ "employer": employer, "run_id": 0, "line_index": 0 }),
            NO_DEPOSIT,
        )
        .await?;
    let error = outcome.assert_failure().to_string();
    assert!(
        error.contains("private") || error.contains("MethodNotFound"),
        "expected a private-method failure, got: {error}"
    );
    let runs_after = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(runs_before, runs_after);
    Ok(())
}

#[tokio::test]
async fn treasury_credit_keeps_tokens_on_the_payroll_account() -> TestResult {
    let (env, tusdc, payroll, employer, _worker) = payroll_payout_fixture().await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let treasury = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    let payroll_balance = env
        .view(&tusdc, "ft_balance_of", json!({ "account_id": payroll }))
        .await?;
    let treasury_u128: u128 = treasury["treasury"].as_str().unwrap().parse()?;
    let balance_u128: u128 = payroll_balance.as_str().unwrap().parse()?;
    assert!(balance_u128 >= treasury_u128);
    Ok(())
}

fn status_counts(runs: &Value) -> (usize, usize) {
    let mut paid = 0usize;
    let mut reserved = 0usize;
    for line in runs[0]["lines"].as_array().expect("lines") {
        match line["status"].as_str() {
            Some("Paid") => paid += 1,
            Some("Reserved") => reserved += 1,
            status => panic!("line status {status:?} is neither Paid nor Reserved"),
        }
    }
    (paid, reserved)
}

/// Q3. A 40-line run pays 20 lines, then the rest. 35 lines fit in 995 Tgas in the
/// sandbox and panic on testnet, so the first call stays at 20. SPEC §7.3.
#[tokio::test]
async fn a_forty_line_run_pays_in_two_calls_under_the_gas_ceiling() -> TestResult {
    let line_count: usize = 40;
    let lines_per_call: usize = 20;
    let line_amount: u128 = 1_000_000;
    let ceiling: u64 = 900_000_000_000_000;
    let (env, tusdc, payroll, employer, first) = payroll_payout_fixture().await?;
    let bounds = env
        .view(&tusdc, "storage_balance_bounds", json!({}))
        .await?;
    let storage: NearToken = serde_json::from_value(bounds["min"].clone())?;
    env.call(
        &employer,
        &tusdc,
        "storage_deposit",
        json!({ "account_id": first }),
        storage,
    )
    .await?
    .assert_success();
    let mut workers = vec![first];
    for index in 1..line_count {
        let worker: AccountId = format!("w-{index:06}.{}", env.root).parse()?;
        env.call(
            &employer,
            &tusdc,
            "storage_deposit",
            json!({ "account_id": worker }),
            storage,
        )
        .await?
        .assert_success();
        env.call(
            &employer,
            &payroll,
            "add_payee",
            json!({ "account_id": worker, "cap": CAP.to_string() }),
            NO_DEPOSIT,
        )
        .await?
        .assert_success();
        workers.push(worker);
    }
    let total = line_amount * line_count as u128;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, total).await?;
    let period = env.open_period().await?;
    let lines: Vec<_> = workers
        .iter()
        .map(|worker| json!({ "account_id": worker, "amount": line_amount.to_string() }))
        .collect();
    let submitted = env
        .call(
            &employer,
            &payroll,
            "submit_run",
            json!({ "period": period, "lines": lines }),
            NO_DEPOSIT,
        )
        .await?;
    let submit_gas = submitted
        .clone()
        .into_full()
        .expect("submit_run execution")
        .total_gas_burnt
        .as_gas();
    submitted.assert_success();
    assert!(submit_gas <= ceiling, "submit_run burnt {submit_gas} gas");

    let first_pay = env
        .call_with_gas(
            &employer,
            &payroll,
            "pay_run",
            json!({ "run_id": 0 }),
            NO_DEPOSIT,
            NearGas::from_tgas(995),
        )
        .await?;
    let full = first_pay.clone().into_full().expect("pay_run execution");
    let pay_gas = full.total_gas_burnt.as_gas();
    eprintln!(
        "{{\"method\":\"pay_run\",\"lines\":{lines_per_call},\"submit_gas\":{submit_gas},\"pay_gas\":{pay_gas},\"receipts\":{},\"failures\":{}}}",
        full.receipt_outcomes().len(),
        full.failures().len(),
    );
    first_pay.assert_success();
    assert_eq!(full.failures().len(), 0, "a failed receipt is not a payout");
    assert!(pay_gas <= ceiling, "pay_run burnt {pay_gas} gas");
    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(
        status_counts(&runs),
        (lines_per_call, line_count - lines_per_call)
    );

    env.call_with_gas(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
        NearGas::from_tgas(1000),
    )
    .await?
    .assert_success();
    let runs = env
        .view(
            &payroll,
            "get_runs",
            json!({ "employer": employer, "period": period }),
        )
        .await?;
    assert_eq!(status_counts(&runs), (line_count, 0));
    Ok(())
}

/// SPEC §7.3 `cancel_run`: reserved money goes back, the period is free again, nothing is paid.
#[tokio::test]
async fn cancel_run_returns_the_reserved_total_and_frees_the_period() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    register_tusdc_storage(&env, &tusdc, &worker).await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (period, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();

    env.call(
        &employer,
        &payroll,
        "cancel_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let run = env
        .view(
            &payroll,
            "get_run",
            json!({ "employer": employer, "run_id": 0 }),
        )
        .await?;
    assert_eq!(run["status"], json!("Cancelled"));
    assert_eq!(run["lines"][0]["status"], json!("Cancelled"));
    let view = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(view["treasury"], json!(PAY_AMOUNT.to_string()));
    // Nothing reached the worker, and the cancelled line does not hold the period
    assert_eq!(
        env.view(&tusdc, "ft_balance_of", json!({ "account_id": worker }))
            .await?,
        json!("0")
    );
    let again = env
        .call(
            &employer,
            &payroll,
            "submit_run",
            json!({ "period": period, "lines": [{ "account_id": worker, "amount": PAY_AMOUNT.to_string() }] }),
            NO_DEPOSIT,
        )
        .await?;
    again.assert_success();
    Ok(())
}

#[tokio::test]
async fn cancel_run_refuses_other_callers_unknown_runs_and_finished_runs() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (_, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();

    // The worker is not an employer, so it cannot cancel the employer's run
    let stranger = env
        .call(
            &worker,
            &payroll,
            "cancel_run",
            json!({ "run_id": 0 }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(stranger, ERR_NOT_EMPLOYER);
    let unknown = env
        .call(
            &employer,
            &payroll,
            "cancel_run",
            json!({ "run_id": 7 }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(unknown, ERR_RUN_NOT_FOUND);
    env.call(
        &employer,
        &payroll,
        "cancel_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let twice = env
        .call(
            &employer,
            &payroll,
            "cancel_run",
            json!({ "run_id": 0 }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(twice, ERR_RUN_COMPLETE);
    let view = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(view["treasury"], json!(PAY_AMOUNT.to_string()));
    Ok(())
}

/// R3: a payee removed after the run was reserved is skipped, and the money returns.
#[tokio::test]
async fn a_payee_removed_before_payment_is_skipped_and_the_money_returns() -> TestResult {
    let (env, tusdc, payroll, employer, worker) = payroll_payout_fixture().await?;
    register_tusdc_storage(&env, &tusdc, &worker).await?;
    fund_treasury_via_transfer_call(&env, &tusdc, &payroll, &employer, PAY_AMOUNT).await?;
    let (_, outcome) = submit_one_line(&env, &payroll, &employer, &worker, PAY_AMOUNT).await?;
    outcome.assert_success();

    env.call(
        &employer,
        &payroll,
        "remove_payee",
        json!({ "account_id": worker }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let payees = env
        .view(&payroll, "get_payees", json!({ "employer": employer }))
        .await?;
    assert_eq!(payees, json!([]));

    env.call(
        &employer,
        &payroll,
        "pay_run",
        json!({ "run_id": 0 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let run = env
        .view(
            &payroll,
            "get_run",
            json!({ "employer": employer, "run_id": 0 }),
        )
        .await?;
    assert_eq!(run["lines"][0]["status"], json!("Skipped"));
    assert_eq!(
        env.view(&tusdc, "ft_balance_of", json!({ "account_id": worker }))
            .await?,
        json!("0")
    );
    let view = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(view["treasury"], json!(PAY_AMOUNT.to_string()));

    let unknown = env
        .call(
            &employer,
            &payroll,
            "remove_payee",
            json!({ "account_id": worker }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(unknown, ERR_UNKNOWN_PAYEE);
    Ok(())
}

#[tokio::test]
async fn get_run_is_null_for_an_unknown_employer_or_run() -> TestResult {
    let (env, payroll, employer, _) = employer_with_one_payee().await?;
    assert_eq!(
        env.view(
            &payroll,
            "get_run",
            json!({ "employer": employer, "run_id": 0 }),
        )
        .await?,
        Value::Null
    );
    assert_eq!(
        env.view(
            &payroll,
            "get_run",
            json!({ "employer": format!("nobody.{}", env.root), "run_id": 0 }),
        )
        .await?,
        Value::Null
    );
    Ok(())
}
