//! tUSDC on a sandbox node (SPEC §7.1): the reference NEP-141 token plus admin-only `mint`.

use homeroll_common::errors::ERR_NOT_ADMIN;
use homeroll_contract_tests::{Contract, Env, assert_fails_with};
use near_api::{AccountId, NearToken};
use serde_json::json;
use testresult::TestResult;

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

struct Setup {
    env: Env,
    tusdc: AccountId,
    alice: AccountId,
    bob: AccountId,
}

/// tUSDC with two holders registered for storage (NEP-145) and no balance yet.
async fn setup() -> TestResult<Setup> {
    let env = Env::start().await?;
    let tusdc = env
        .deploy(Contract::Tusdc, json!({ "admin": env.root }))
        .await?;
    let alice = env.create_user("alice").await?;
    let bob = env.create_user("bob").await?;
    let bounds = env
        .view(&tusdc, "storage_balance_bounds", json!({}))
        .await?;
    let storage: NearToken = serde_json::from_value(bounds["min"].clone())?;
    for holder in [&alice, &bob] {
        env.call(holder, &tusdc, "storage_deposit", json!({}), storage)
            .await?
            .assert_success();
    }
    Ok(Setup {
        env,
        tusdc,
        alice,
        bob,
    })
}

impl Setup {
    async fn balance(&self, account_id: &AccountId) -> TestResult<String> {
        let balance = self
            .env
            .view(
                &self.tusdc,
                "ft_balance_of",
                json!({ "account_id": account_id }),
            )
            .await?;
        Ok(balance.as_str().unwrap_or_default().to_owned())
    }

    async fn mint(&self, signer: &AccountId, to: &AccountId, amount: u128) -> TestResult {
        self.env
            .call(
                signer,
                &self.tusdc,
                "mint",
                json!({ "account_id": to, "amount": amount.to_string() }),
                NO_DEPOSIT,
            )
            .await?
            .assert_success();
        Ok(())
    }
}

#[tokio::test]
async fn only_the_admin_can_mint() -> TestResult {
    let s = setup().await?;

    let outcome = s
        .env
        .call(
            &s.alice,
            &s.tusdc,
            "mint",
            json!({ "account_id": s.alice, "amount": "1000000" }),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, ERR_NOT_ADMIN);
    assert_eq!(s.balance(&s.alice).await?, "0");

    s.mint(&s.env.root, &s.alice, 1_000_000).await?;
    assert_eq!(s.balance(&s.alice).await?, "1000000");
    let supply = s.env.view(&s.tusdc, "ft_total_supply", json!({})).await?;
    assert_eq!(supply, json!("1000000"));
    Ok(())
}

/// The 1-yocto rule is what stops a function-call key, like the payroll agent's, from
/// ever moving tokens (SPEC §6, attack 05).
#[tokio::test]
async fn ft_transfer_needs_exactly_one_yocto() -> TestResult {
    let s = setup().await?;
    s.mint(&s.env.root, &s.alice, 1_000_000).await?;
    let transfer = json!({ "receiver_id": s.bob, "amount": "400000" });

    let outcome = s
        .env
        .call(
            &s.alice,
            &s.tusdc,
            "ft_transfer",
            transfer.clone(),
            NO_DEPOSIT,
        )
        .await?;
    assert_fails_with(outcome, "Requires attached deposit of exactly 1 yoctoNEAR");
    assert_eq!(s.balance(&s.bob).await?, "0");

    s.env
        .call(&s.alice, &s.tusdc, "ft_transfer", transfer, ONE_YOCTO)
        .await?
        .assert_success();
    assert_eq!(s.balance(&s.alice).await?, "600000");
    assert_eq!(s.balance(&s.bob).await?, "400000");
    Ok(())
}
