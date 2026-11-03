//! Payroll on a sandbox node (SPEC §7.3): admin onboarding (R15) and the wage cap (R4).

use homeroll_common::errors::{
    ERR_ABOVE_WAGE_CAP, ERR_BELOW_BUFFER, ERR_EMPLOYER_EXISTS, ERR_NOT_ADMIN, ERR_TOO_MANY_PAYEES,
    line_error,
};
use homeroll_contract_tests::{Contract, Env, assert_fails_with};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
use testresult::TestResult;

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// 500 tUSDC in base units (6 decimals). Synthetic.
const CAP: u128 = 500_000_000;

/// Payroll on `payroll.<root>`, one employer onboarded with no buffer, one payee at CAP.
/// The payee account need not exist: nothing is transferred in this unit.
async fn employer_with_one_payee() -> TestResult<(Env, AccountId, AccountId, AccountId)> {
    let env = Env::start().await?;
    let payroll = env
        .deploy(Contract::Payroll, json!({ "admin": env.root }))
        .await?;
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
    let payroll = env
        .deploy(Contract::Payroll, json!({ "admin": env.root }))
        .await?;
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
    let payroll = env
        .deploy(Contract::Payroll, json!({ "admin": env.root }))
        .await?;
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
    let payroll = env
        .deploy(Contract::Payroll, json!({ "admin": env.root }))
        .await?;
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
