//! Pool on a sandbox node (SPEC §7.4): lender deposits, invoice lifecycle, settlement.

use homeroll_common::errors::{
    ERR_ADVANCE_ABOVE_CAP, ERR_BUYER_EXPOSURE, ERR_DEPOSIT_TOO_SMALL,
    ERR_INVOICE_ALREADY_REGISTERED, ERR_NOT_ADMIN, ERR_NOT_AGENT, ERR_NOT_SETTLER,
};
use homeroll_contract_tests::{Contract, Env, assert_fails_with};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
use testresult::TestResult;

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MIN_FIRST_DEPOSIT: u128 = 10_000_000;
const INVOICE_AMOUNT: u128 = 100_000_000;
const ADVANCE: u128 = 80_000_000;
const FEE: u128 = 1_200_000;
const SETTLE_PAYMENT: u128 = ADVANCE + FEE + 8_800_000;

fn payroll_account(root: &AccountId) -> AccountId {
    Contract::Payroll.account_id(root)
}

#[track_caller]
fn assert_receipt_panics_with(outcome: TransactionResult, code: &str) {
    let error = format!("{outcome:?}");
    assert!(
        error.contains(code),
        "expected {code} in transaction receipts, got: {error}"
    );
}

async fn register_tusdc_storage(env: &Env, tusdc: &AccountId, account: &AccountId) -> TestResult {
    let bounds = env.view(tusdc, "storage_balance_bounds", json!({})).await?;
    let storage: NearToken = serde_json::from_value(bounds["min"].clone())?;
    env.call(account, tusdc, "storage_deposit", json!({}), storage)
        .await?
        .assert_success();
    Ok(())
}

async fn mint(env: &Env, tusdc: &AccountId, account: &AccountId, amount: u128) -> TestResult {
    env.call(
        &env.root,
        tusdc,
        "mint",
        json!({ "account_id": account, "amount": amount.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    Ok(())
}

async fn ft_transfer_call(
    env: &Env,
    tusdc: &AccountId,
    signer: &AccountId,
    receiver: &AccountId,
    amount: u128,
    msg: Value,
) -> TestResult {
    env.call(
        signer,
        tusdc,
        "ft_transfer_call",
        json!({
            "receiver_id": receiver,
            "amount": amount.to_string(),
            "memo": null,
            "msg": msg.to_string(),
        }),
        ONE_YOCTO,
    )
    .await?
    .assert_success();
    Ok(())
}

async fn ft_balance_of(env: &Env, tusdc: &AccountId, account: &AccountId) -> TestResult<u128> {
    let bal = env
        .view(tusdc, "ft_balance_of", json!({ "account_id": account }))
        .await?;
    Ok(bal.as_str().unwrap().parse()?)
}

async fn deploy_pool_stack(env: &Env) -> TestResult<(AccountId, AccountId, AccountId)> {
    let tusdc = env
        .deploy(Contract::Tusdc, json!({ "admin": env.root }))
        .await?;
    let payroll = env
        .deploy(
            Contract::Payroll,
            json!({ "admin": env.root, "token": tusdc }),
        )
        .await?;
    let pool = env
        .deploy(
            Contract::Pool,
            json!({ "admin": env.root, "token": tusdc, "payroll": payroll }),
        )
        .await?;
    register_tusdc_storage(env, &tusdc, &pool).await?;
    Ok((tusdc, payroll, pool))
}

async fn pool_with_lender_deposit(
    amount: u128,
) -> TestResult<(Env, AccountId, AccountId, AccountId)> {
    let env = Env::start().await?;
    let (tusdc, _payroll, pool) = deploy_pool_stack(&env).await?;
    let lender = env.create_user("lender").await?;
    register_tusdc_storage(&env, &tusdc, &lender).await?;
    mint(&env, &tusdc, &lender, amount).await?;
    ft_transfer_call(
        &env,
        &tusdc,
        &lender,
        &pool,
        amount,
        json!({ "deposit": {} }),
    )
    .await?;
    Ok((env, tusdc, pool, lender))
}

#[tokio::test]
async fn r15_first_deposit_floor_and_admin_gate() -> TestResult {
    let env = Env::start().await?;
    let (tusdc, _payroll, pool) = deploy_pool_stack(&env).await?;
    let lender = env.create_user("newlender").await?;
    register_tusdc_storage(&env, &tusdc, &lender).await?;
    mint(&env, &tusdc, &lender, MIN_FIRST_DEPOSIT).await?;

    let outcome = env
        .call(
            &lender,
            &tusdc,
            "ft_transfer_call",
            json!({
                "receiver_id": pool,
                "amount": "9999999",
                "memo": null,
                "msg": json!({ "deposit": {} }).to_string(),
            }),
            ONE_YOCTO,
        )
        .await?;
    assert_receipt_panics_with(outcome, ERR_DEPOSIT_TOO_SMALL);
    assert_eq!(
        ft_balance_of(&env, &tusdc, &lender).await?,
        MIN_FIRST_DEPOSIT
    );
    let pool_view = env.view(&pool, "get_pool", json!({})).await?;
    assert_eq!(pool_view["cash"], "0");
    assert_eq!(
        env.view(&pool, "get_lender", json!({ "account_id": lender }))
            .await?,
        Value::Null
    );

    ft_transfer_call(
        &env,
        &tusdc,
        &lender,
        &pool,
        MIN_FIRST_DEPOSIT,
        json!({ "deposit": {} }),
    )
    .await?;
    let lender_view = env
        .view(&pool, "get_lender", json!({ "account_id": lender }))
        .await?;
    assert_eq!(lender_view["shares"], MIN_FIRST_DEPOSIT.to_string());

    mint(&env, &tusdc, &lender, 1).await?;
    ft_transfer_call(&env, &tusdc, &lender, &pool, 1, json!({ "deposit": {} })).await?;

    let stranger = env.create_user("stranger").await?;
    let outcome = env
        .call(
            &stranger,
            &pool,
            "set_min_first_deposit",
            json!({ "min_first_deposit": "0" }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_NOT_ADMIN);
    Ok(())
}

async fn pool_attest_fixture() -> TestResult<(
    Env,
    AccountId,
    AccountId,
    AccountId,
    AccountId,
    AccountId,
    String,
)> {
    let (env, tusdc, pool, _lender) = pool_with_lender_deposit(1_000_000_000).await?;
    let agent = env.create_user("agent").await?;
    env.call(
        &env.root,
        &pool,
        "add_agent",
        json!({ "account_id": agent }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let employer = env.create_user("coffeefactory").await?;
    let payroll = payroll_account(&env.root);
    register_tusdc_storage(&env, &tusdc, &payroll).await?;
    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": employer, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &env.root,
        &pool,
        "set_max_buyer_exposure",
        json!({ "max_buyer_exposure": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let invoice_hash = "inv-hash-r7".to_owned();
    Ok((env, tusdc, pool, agent, employer, payroll, invoice_hash))
}

fn attest_args(invoice_hash: &str, employer: &AccountId, buyer_hash: &str) -> Value {
    json!({
        "invoice_hash": invoice_hash,
        "employer": employer,
        "buyer_hash": buyer_hash,
        "amount": INVOICE_AMOUNT.to_string(),
        "due_ts": "1797379200000000000",
        "grade": "A",
        "attestation_ref": "none",
    })
}

#[tokio::test]
async fn r7_invoice_hash_is_unique_for_attest_and_advance() -> TestResult {
    let (env, _tusdc, pool, agent, employer, _payroll, invoice_hash) =
        pool_attest_fixture().await?;
    let buyer = "buyer-a";

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(&invoice_hash, &employer, buyer),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let invoice = env
        .view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash }),
        )
        .await?;
    assert_eq!(invoice["status"], "Attested");

    env.call(
        &employer,
        &pool,
        "request_advance",
        json!({ "invoice_hash": invoice_hash, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let invoice = env
        .view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash }),
        )
        .await?;
    assert_eq!(invoice["status"], "Advanced");
    assert_eq!(invoice["credited"], true);

    let pool_before = env.view(&pool, "get_pool", json!({})).await?;
    let outcome = env
        .call(
            &agent,
            &pool,
            "attest_invoice",
            attest_args(&invoice_hash, &employer, buyer),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_INVOICE_ALREADY_REGISTERED);

    let outcome = env
        .call(
            &employer,
            &pool,
            "request_advance",
            json!({ "invoice_hash": invoice_hash, "amount": "1" }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_INVOICE_ALREADY_REGISTERED);

    let pool_after = env.view(&pool, "get_pool", json!({})).await?;
    assert_eq!(pool_after["cash"], pool_before["cash"]);
    assert_eq!(pool_after["outstanding"], pool_before["outstanding"]);
    Ok(())
}

#[tokio::test]
async fn r10_only_agents_attest() -> TestResult {
    let (env, _tusdc, pool, _agent, employer, _payroll, invoice_hash) =
        pool_attest_fixture().await?;
    let stranger = env.create_user("notagent").await?;
    let outcome = env
        .call(
            &stranger,
            &pool,
            "attest_invoice",
            attest_args(&invoice_hash, &employer, "buyer-b"),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_NOT_AGENT);
    assert_eq!(
        env.view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash }),
        )
        .await?,
        Value::Null
    );
    Ok(())
}

#[tokio::test]
async fn r8_advance_cap_grade_d_and_hard_max() -> TestResult {
    let (env, _tusdc, pool, agent, employer, _payroll, invoice_hash) =
        pool_attest_fixture().await?;

    env.call(
        &env.root,
        &pool,
        "set_grade",
        json!({ "grade": "A", "max_advance_bps": 9000, "fee_bps": 150 }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let grades = env.view(&pool, "get_pool", json!({})).await?["grades"].clone();
    assert_eq!(grades["A"]["max_advance_bps"], 8000);

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(&invoice_hash, &employer, "buyer-c"),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let outcome = env
        .call(
            &employer,
            &pool,
            "request_advance",
            json!({ "invoice_hash": invoice_hash, "amount": (ADVANCE + 1).to_string() }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_ADVANCE_ABOVE_CAP);

    env.call(
        &employer,
        &pool,
        "request_advance",
        json!({ "invoice_hash": invoice_hash, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let declined_hash = "inv-grade-d";
    env.call(
        &agent,
        &pool,
        "attest_invoice",
        json!({
            "invoice_hash": declined_hash,
            "employer": employer,
            "buyer_hash": "buyer-d",
            "amount": INVOICE_AMOUNT.to_string(),
            "due_ts": "1797379200000000000",
            "grade": "D",
            "attestation_ref": "none",
        }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let declined = env
        .view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": declined_hash }),
        )
        .await?;
    assert_eq!(declined["status"], "Declined");
    let outcome = env
        .call(
            &employer,
            &pool,
            "request_advance",
            json!({ "invoice_hash": declined_hash, "amount": "1" }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_ADVANCE_ABOVE_CAP);
    Ok(())
}

#[tokio::test]
async fn r11_buyer_exposure_limit_and_revert() -> TestResult {
    let (env, _tusdc, pool, agent, employer, payroll, _) = pool_attest_fixture().await?;
    let buyer = "shared-buyer";
    let hash1 = "inv-b11-a";
    let hash2 = "inv-b11-b";

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(hash1, &employer, buyer),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &employer,
        &pool,
        "request_advance",
        json!({ "invoice_hash": hash1, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(hash2, &employer, buyer),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let outcome = env
        .call(
            &employer,
            &pool,
            "request_advance",
            json!({ "invoice_hash": hash2, "amount": ADVANCE.to_string() }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_BUYER_EXPOSURE);
    assert_eq!(
        env.view(&pool, "get_invoice", json!({ "invoice_hash": hash2 }))
            .await?["status"],
        "Attested"
    );

    let unregistered = env.create_user("noemployer").await?;
    let hash3 = "inv-b11-c";
    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(hash3, &unregistered, "buyer-other"),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &env.root,
        &pool,
        "set_max_buyer_exposure",
        json!({ "max_buyer_exposure": (ADVANCE * 2).to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &unregistered,
        &pool,
        "request_advance",
        json!({ "invoice_hash": hash3, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let invoice = env
        .view(&pool, "get_invoice", json!({ "invoice_hash": hash3 }))
        .await?;
    assert_eq!(invoice["status"], "Attested");
    assert_eq!(invoice["credited"], false);

    env.call(
        &env.root,
        &payroll,
        "register_employer",
        json!({ "employer": unregistered, "buffer": "0" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &unregistered,
        &pool,
        "request_advance",
        json!({ "invoice_hash": hash3, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let invoice = env
        .view(&pool, "get_invoice", json!({ "invoice_hash": hash3 }))
        .await?;
    assert_eq!(invoice["credited"], true);
    Ok(())
}

#[tokio::test]
async fn r10_only_settlers_settle() -> TestResult {
    let (env, tusdc, pool, agent, employer, _payroll, invoice_hash) = pool_attest_fixture().await?;
    let settler = env.create_user("settler").await?;
    env.call(
        &env.root,
        &pool,
        "add_settler",
        json!({ "account_id": settler }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    register_tusdc_storage(&env, &tusdc, &settler).await?;

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(&invoice_hash, &employer, "buyer-settle"),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &employer,
        &pool,
        "request_advance",
        json!({ "invoice_hash": invoice_hash, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    let stranger = env.create_user("notsettler").await?;
    register_tusdc_storage(&env, &tusdc, &stranger).await?;
    mint(&env, &tusdc, &stranger, SETTLE_PAYMENT).await?;
    let outcome = env
        .call(
            &stranger,
            &tusdc,
            "ft_transfer_call",
            json!({
                "receiver_id": pool,
                "amount": SETTLE_PAYMENT.to_string(),
                "memo": null,
                "msg": json!({ "settle": { "invoice_hash": invoice_hash } }).to_string(),
            }),
            ONE_YOCTO,
        )
        .await?;
    assert_receipt_panics_with(outcome, ERR_NOT_SETTLER);
    assert_eq!(
        env.view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash })
        )
        .await?["status"],
        "Advanced"
    );

    mint(&env, &tusdc, &settler, SETTLE_PAYMENT).await?;
    ft_transfer_call(
        &env,
        &tusdc,
        &settler,
        &pool,
        SETTLE_PAYMENT,
        json!({ "settle": { "invoice_hash": invoice_hash } }),
    )
    .await?;
    let invoice = env
        .view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash }),
        )
        .await?;
    assert_eq!(invoice["status"], "Settled");
    assert_eq!(invoice["stranded_rest"], "0");
    Ok(())
}

#[tokio::test]
async fn settle_repays_pool_and_forwards_rest_to_payroll_treasury() -> TestResult {
    let (env, tusdc, pool, agent, employer, payroll, invoice_hash) = pool_attest_fixture().await?;
    let settler = env.create_user("settler2").await?;
    env.call(
        &env.root,
        &pool,
        "add_settler",
        json!({ "account_id": settler }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    register_tusdc_storage(&env, &tusdc, &settler).await?;

    env.call(
        &agent,
        &pool,
        "attest_invoice",
        attest_args(&invoice_hash, &employer, "buyer-e2e"),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    env.call(
        &employer,
        &pool,
        "request_advance",
        json!({ "invoice_hash": invoice_hash, "amount": ADVANCE.to_string() }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();

    mint(&env, &tusdc, &settler, SETTLE_PAYMENT).await?;
    ft_transfer_call(
        &env,
        &tusdc,
        &settler,
        &pool,
        SETTLE_PAYMENT,
        json!({ "settle": { "invoice_hash": invoice_hash } }),
    )
    .await?;

    let employer_state = env
        .view(&payroll, "get_employer", json!({ "employer": employer }))
        .await?;
    assert_eq!(employer_state["treasury"], "88800000");

    let pool_view = env.view(&pool, "get_pool", json!({})).await?;
    let expected_cash = 1_000_000_000 - ADVANCE + ADVANCE + FEE;
    assert_eq!(
        pool_view["cash"].as_str().unwrap().parse::<u128>()?,
        expected_cash
    );
    assert_eq!(pool_view["outstanding"], "0");
    assert_eq!(pool_view["fees_earned"], FEE.to_string());

    let invoice = env
        .view(
            &pool,
            "get_invoice",
            json!({ "invoice_hash": invoice_hash }),
        )
        .await?;
    assert_eq!(invoice["status"], "Settled");
    assert_eq!(invoice["stranded_rest"], "0");
    Ok(())
}

#[tokio::test]
async fn withdraw_lender_pays_from_cash() -> TestResult {
    let (env, tusdc, pool, lender) = pool_with_lender_deposit(50_000_000).await?;
    let before = ft_balance_of(&env, &tusdc, &lender).await?;
    env.call(
        &lender,
        &pool,
        "withdraw_lender",
        json!({ "shares": "10000000" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    let after = ft_balance_of(&env, &tusdc, &lender).await?;
    assert!(after > before);
    let lender_view = env
        .view(&pool, "get_lender", json!({ "account_id": lender }))
        .await?;
    assert_eq!(
        lender_view["shares"].as_str().unwrap().parse::<u128>()?,
        40_000_000
    );
    Ok(())
}
