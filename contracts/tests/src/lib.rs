//! Sandbox helpers for the integration tests. Contracts are built with `cargo near`,
//! the same build as `pnpm build:contracts`, and deployed under a root account laid
//! out as on testnet (SPEC §6).

use std::sync::{Arc, Mutex};

use cargo_near_build::{BuildOpts, camino::Utf8PathBuf};
use homeroll_common::period::Period;
use near_api::types::transaction::result::TransactionResult;
use near_api::{Account, AccountId, Chain, NearGas, NearToken, NetworkConfig, PublicKey, Signer};
use near_sandbox::{
    Sandbox,
    config::{DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY, DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY},
};
use serde_json::Value;
use testresult::TestResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Contract {
    Tusdc,
    Factory,
    Payroll,
    Pool,
}

impl Contract {
    pub const ALL: [Self; 4] = [Self::Tusdc, Self::Factory, Self::Payroll, Self::Pool];

    const fn crate_dir(self) -> &'static str {
        match self {
            Self::Tusdc => "tusdc",
            Self::Factory => "factory",
            Self::Payroll => "payroll",
            Self::Pool => "pool",
        }
    }

    /// The factory lives on the root itself; every other contract on `<name>.<root>`.
    pub fn account_id(self, root: &AccountId) -> AccountId {
        match self {
            Self::Factory => root.clone(),
            other => format!("{}.{root}", other.crate_dir())
                .parse()
                .expect("contract sub-account id is valid"),
        }
    }

    /// Builds at most once per test binary. `cargo near` also skips the compile when
    /// nothing changed, so this stays fast across runs.
    pub fn wasm(self) -> TestResult<Vec<u8>> {
        static BUILT: Mutex<[Option<Vec<u8>>; 4]> = Mutex::new([None, None, None, None]);

        let mut built = BUILT.lock().expect("build cache lock is not poisoned");
        let slot = &mut built[self as usize];
        if let Some(wasm) = slot {
            return Ok(wasm.clone());
        }
        let manifest = format!(
            "{}/../{}/Cargo.toml",
            env!("CARGO_MANIFEST_DIR"),
            self.crate_dir()
        );
        let opts = BuildOpts {
            manifest_path: Some(Utf8PathBuf::from(manifest)),
            ..Default::default()
        };
        let wasm = std::fs::read(cargo_near_build::build_with_cli(opts)?)?;
        *slot = Some(wasm.clone());
        Ok(wasm)
    }
}

/// A fresh sandbox node with a funded root account. Every account it creates uses the
/// genesis key, so `signer` signs for all of them and `public_key()` is that key.
pub struct Env {
    pub sandbox: Sandbox,
    pub network: NetworkConfig,
    pub root: AccountId,
    pub signer: Arc<Signer>,
}

impl Env {
    pub async fn start() -> TestResult<Self> {
        let sandbox = Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        let root: AccountId = "homeroll.sandbox".parse()?;
        sandbox
            .create_account(root.clone())
            .initial_balance(NearToken::from_near(1_000))
            .send()
            .await?;
        Ok(Self {
            sandbox,
            network,
            root,
            signer,
        })
    }

    /// Creates the contract's account (unless it is the root), then deploys the contract
    /// and calls `new(init_args)` in one transaction, as the testnet deploy does.
    pub async fn deploy(
        &self,
        contract: Contract,
        init_args: serde_json::Value,
    ) -> TestResult<AccountId> {
        let account_id = contract.account_id(&self.root);
        if account_id != self.root {
            self.sandbox
                .create_account(account_id.clone())
                .initial_balance(NearToken::from_near(50))
                .send()
                .await?;
        }
        near_api::Contract::deploy(account_id.clone())
            .use_code(contract.wasm()?)
            .with_init_call("new", init_args)?
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await?
            .assert_success();
        Ok(account_id)
    }

    /// A plain account with no contract, such as a stranger or a lender.
    pub async fn create_user(&self, name: &str) -> TestResult<AccountId> {
        let account_id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(account_id.clone())
            .initial_balance(NearToken::from_near(10))
            .send()
            .await?;
        Ok(account_id)
    }

    /// The key every sandbox account signs with.
    pub fn public_key(&self) -> TestResult<PublicKey> {
        Ok(DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY.parse()?)
    }

    /// Calls `method` on `contract`, signed by `signer`, with 300 Tgas. Check the result
    /// with `assert_success()` or [`assert_fails_with`].
    ///
    /// `near-api`'s `max_gas` is 300 Tgas. The live protocol `gas_limit` is 1000 Tgas.
    /// A measurement that must use the protocol ceiling calls [`Self::call_with_gas`].
    pub async fn call(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<TransactionResult> {
        self.call_with_gas(
            signer,
            contract,
            method,
            args,
            deposit,
            NearGas::from_tgas(300),
        )
        .await
    }

    pub async fn call_with_gas(
        &self,
        signer: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: NearGas,
    ) -> TestResult<TransactionResult> {
        Ok(near_api::Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .gas(gas)
            .deposit(deposit)
            .with_signer(signer.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?)
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> TestResult<Value> {
        Ok(near_api::Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    /// `false` only when the node says the account is unknown; any other error panics.
    pub async fn account_exists(&self, account_id: &AccountId) -> bool {
        match Account(account_id.clone())
            .view()
            .fetch_from(&self.network)
            .await
        {
            Ok(_) => true,
            Err(error) if error.to_string().contains("UnknownAccount") => false,
            Err(error) => panic!("querying {account_id} failed: {error}"),
        }
    }

    /// The period containing the latest block. A call sent now lands in this month or the
    /// next, and R14 keeps the previous month open.
    ///
    /// `timestamp_nanosec` is the locked field (`String` of nanoseconds). The legacy
    /// `timestamp` number is the wrong field.
    pub async fn open_period(&self) -> TestResult<String> {
        let block = Chain::block().fetch_from(&self.network).await?;
        let now_ns: u64 = block.header.timestamp_nanosec.parse()?;
        Ok(Period::containing(now_ns).to_string())
    }

    pub async fn near_balance(&self, account_id: &AccountId) -> TestResult<NearToken> {
        Ok(Account(account_id.clone())
            .view()
            .fetch_from(&self.network)
            .await?
            .data
            .amount)
    }
}

/// Asserts that the transaction failed with `code` in its error: one of our `ERR_`
/// constants, or a NEAR or SDK message when the failure is not ours.
#[track_caller]
pub fn assert_fails_with(outcome: TransactionResult, code: &str) {
    let error = outcome.assert_failure().to_string();
    assert!(error.contains(code), "expected {code}, got: {error}");
}
