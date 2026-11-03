# The Homeroll admin onboards employers

Only the Homeroll admin can call `register_employer`, and each employer has a payee limit. On NEAR a contract pays for its own storage, so if anyone could register and add payees, a stranger could fill the payroll contract's storage for the price of gas until every write failed, real employers' payroll included. Real employers are vetted before they can pay workers anyway. The pool applies the same idea to lenders with a minimum first deposit.

## Considered options

- **Employers prepay their storage (NEP-145 style).** The payroll agent's function-call key cannot attach deposits, so storage for each run would need a separate prepaid balance and extra code to track it.
