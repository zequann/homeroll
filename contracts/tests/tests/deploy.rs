use homeroll_contract_tests::{Contract, Env};
use serde_json::json;
use testresult::TestResult;

#[tokio::test]
async fn every_contract_deploys_and_initialises_under_the_root() -> TestResult {
    let env = Env::start().await?;
    let admin = &env.root;
    let tusdc = env
        .deploy(Contract::Tusdc, json!({ "admin": admin }))
        .await?;
    env.deploy(Contract::Factory, json!({ "admin": admin, "token": tusdc }))
        .await?;
    let payroll = env
        .deploy(Contract::Payroll, json!({ "admin": admin, "token": tusdc }))
        .await?;
    env.deploy(
        Contract::Pool,
        json!({ "admin": admin, "token": tusdc, "payroll": payroll }),
    )
    .await?;
    Ok(())
}
