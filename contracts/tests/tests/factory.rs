//! Factory on a sandbox node (SPEC §7.2): pseudonymous worker accounts, funded for
//! storage and registered on tUSDC so payroll can pay them.

use homeroll_common::errors::{
    ERR_ACCOUNT_EXISTS, ERR_INVALID_NAME, ERR_NOT_ADMIN, ERR_TOKEN_REGISTRATION_FAILED,
};
use homeroll_contract_tests::{Contract, Env, assert_fails_with};
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::result::TransactionResult;
use near_api::{Account, AccountId, NearToken};
use serde_json::{Value, json};
use testresult::TestResult;

const WORKER: &str = "w-7k2q9x";
const WORKER_FUNDING: NearToken = NearToken::from_millinear(50);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

/// tUSDC on `tusdc.<root>` and the factory on the root, pointing at it.
async fn setup() -> TestResult<(Env, AccountId)> {
    let env = Env::start().await?;
    let tusdc = env
        .deploy(Contract::Tusdc, json!({ "admin": env.root }))
        .await?;
    env.deploy(
        Contract::Factory,
        json!({ "admin": env.root, "token": tusdc }),
    )
    .await?;
    Ok((env, tusdc))
}

async fn create_worker(env: &Env, signer: &AccountId, name: &str) -> TestResult<TransactionResult> {
    let args = json!({ "name": name, "public_key": env.public_key()?.to_string() });
    env.call(signer, &env.root, "create_worker", args, NO_DEPOSIT)
        .await
}

fn worker_id(env: &Env) -> TestResult<AccountId> {
    Ok(format!("{WORKER}.{}", env.root).parse()?)
}

#[tokio::test]
async fn admin_creates_a_funded_worker_that_can_hold_tusdc() -> TestResult {
    let (env, tusdc) = setup().await?;
    let worker = worker_id(&env)?;

    let created: String = create_worker(&env, &env.root, WORKER)
        .await?
        .assert_success()
        .json()?;
    assert_eq!(created, worker.to_string());

    assert_eq!(env.near_balance(&worker).await?, WORKER_FUNDING);
    let keys = Account(worker.clone())
        .list_keys()
        .fetch_from(&env.network)
        .await?
        .data;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].0, env.public_key()?);
    assert!(matches!(
        keys[0].1.permission,
        AccessKeyPermission::FullAccess
    ));

    // Registered on the token, so a payroll transfer to it can succeed.
    let storage = env
        .view(
            &tusdc,
            "storage_balance_of",
            json!({ "account_id": worker }),
        )
        .await?;
    assert_ne!(storage, Value::Null);
    env.call(
        &env.root,
        &tusdc,
        "mint",
        json!({ "account_id": worker, "amount": "1950000000" }),
        NO_DEPOSIT,
    )
    .await?
    .assert_success();
    Ok(())
}

#[tokio::test]
async fn a_taken_name_fails_and_the_factory_keeps_its_near() -> TestResult {
    let (env, _) = setup().await?;
    create_worker(&env, &env.root, WORKER)
        .await?
        .assert_success();
    let before = env.near_balance(&env.root).await?;

    assert_fails_with(
        create_worker(&env, &env.root, WORKER).await?,
        ERR_ACCOUNT_EXISTS,
    );

    // Let the refund receipts land before comparing balances.
    env.sandbox.fast_forward(2).await?;
    let spent = before.saturating_sub(env.near_balance(&env.root).await?);
    assert!(
        spent < WORKER_FUNDING,
        "only gas may be spent; the 0.05 NEAR must come back, spent {spent}"
    );
    Ok(())
}

#[tokio::test]
async fn only_the_admin_can_create_workers() -> TestResult {
    let (env, _) = setup().await?;
    let stranger = env.create_user("stranger").await?;

    assert_fails_with(create_worker(&env, &stranger, WORKER).await?, ERR_NOT_ADMIN);
    assert!(
        !env.account_exists(&worker_id(&env)?).await,
        "no account was created"
    );
    Ok(())
}

/// R13: a real name never becomes an account ID.
#[tokio::test]
async fn a_real_name_is_rejected() -> TestResult {
    let (env, _) = setup().await?;
    assert_fails_with(
        create_worker(&env, &env.root, "rahim").await?,
        ERR_INVALID_NAME,
    );
    Ok(())
}

/// NEAR does not roll back the new account when a later step fails, so the failure
/// must be loud rather than leave a worker who cannot be paid.
#[tokio::test]
async fn a_failed_token_registration_is_reported() -> TestResult {
    let env = Env::start().await?;
    let no_token: AccountId = format!("missing.{}", env.root).parse()?;
    env.deploy(
        Contract::Factory,
        json!({ "admin": env.root, "token": no_token }),
    )
    .await?;

    assert_fails_with(
        create_worker(&env, &env.root, WORKER).await?,
        ERR_TOKEN_REGISTRATION_FAILED,
    );
    assert_eq!(env.near_balance(&worker_id(&env)?).await?, WORKER_FUNDING);
    Ok(())
}
