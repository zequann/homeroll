# Homeroll

Homeroll gives Malaysian employers an invoice advance, pays their foreign workers through a guarded payroll, and lets workers send money home. These are the words the spec, code and UI use for it.

## Language

### Parties

**Employer**:
A company that Homeroll has onboarded to pay its workers through Homeroll.
_Avoid_: company, business, SME (when you mean the party that pays)

**Owner**:
The person who controls an employer: approves payees and wage caps, and runs payroll.
_Avoid_: HR (the same person here), admin

**Homeroll admin**:
The operator that onboards employers and decides which agents the contracts trust.
_Avoid_: deployer, admin (on its own)

**Worker**:
A person an employer pays, known on-chain only by a random pseudonymous account; their name lives off-chain.
_Avoid_: employee, staff

**Payee**:
A worker an employer has registered to receive pay, with a wage cap.
_Avoid_: recipient, beneficiary

### Payroll

**Treasury**:
The employer's money held for payroll.
_Avoid_: balance, wallet

**Buffer**:
The minimum the treasury must still hold after any payroll run.
_Avoid_: reserve, float

**Wage cap**:
The most a payee may be paid for one period.
_Avoid_: contract cap ("contract" also means the smart contract), limit

**Hold**:
The 48-hour wait before a new payee, or a raised wage cap, takes effect.
_Avoid_: delay, cooldown

**Period**:
The calendar month a payroll run pays for. A period is open for runs during that month and the month after.
_Avoid_: cycle, pay month

**Pay line**:
One payee and one amount in a payroll run.
_Avoid_: line item, payment

**Payroll run**:
An employer's pay lines for one period, checked as a whole before any of them is paid; if one line fails a check, nothing in the run is paid. An employer may submit several runs for a period, but a payee is paid at most once per period.
_Avoid_: batch, chunk (a run may be paid out over several transactions, but those are not a domain concept)

### Lending

**Pool**:
The money lenders put up to fund invoice advances; each lender owns shares of it.
_Avoid_: vault, fund

**Lender**:
Someone who deposits USDC into the pool and earns the advance fees.
_Avoid_: investor, LP

**Cross-chain deposit**:
A lender's deposit that starts as another asset on another chain and arrives in the pool as USDC on NEAR.
_Avoid_: bridge, on-ramp (an on-ramp turns bank money into crypto)

### Sending money home

**All-in cost**:
Everything a send-home costs the worker, fees plus FX margin, as a share of the amount sent.
_Avoid_: fee (a fee is only part of it)

**Swap leg**:
The on-chain part of a send-home, which turns the worker's USDC into the payout partner's currency.
_Avoid_: bridge, conversion

**Payout leg**:
The part of a send-home where a licensed partner pays the family in local money.
_Avoid_: cash-out (that is a worker withdrawing in Malaysia)
