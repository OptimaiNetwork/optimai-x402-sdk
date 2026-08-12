# Security Policy

## Supported Versions

Security fixes are provided for the latest version of
`@optimai-network/x402-sdk` published on npm. Please reproduce a report against
the latest version when possible.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use the repository's **Security** tab and select **Report a vulnerability** to
submit a private report. If private reporting is unavailable, email
`tech@optimai.network` with the subject `OptimAI x402 SDK security report`.

Include:

- the affected SDK version and runtime
- the relevant network, such as Base or Solana
- a clear description of the impact
- minimal reproduction steps or a proof of concept
- any suggested mitigation

Do not include real private keys, seed phrases, access tokens, or private user
data. Use a dedicated test wallet and redact secrets from logs and screenshots.

## Security Expectations

The following properties are security-sensitive:

- payer private keys remain under the caller's control and are never transmitted
  as raw key material
- a selected payment requirement preserves the challenged network, asset,
  amount, and recipient
- unsupported payment networks fail closed
- failed, cancelled, timed-out, or resultless searches do not trigger a fresh
  result payment
- retries and idempotent requests do not create unintended duplicate payments

Reports showing a realistic violation of these properties are in scope.

## Safe Testing

Use wallets and funds you control. Keep test transactions minimal, avoid
accessing other users' data, and do not disrupt the public service. If testing
could affect production availability, user data, or third-party funds, contact
us before proceeding.

## Out of Scope

The following are not actionable without a demonstrated SDK-specific security
impact:

- vulnerabilities only in an upstream dependency
- social engineering, spam, or denial-of-service traffic
- reports based only on automated scanner output
- issues in unrelated OptimAI services

You may still use the private reporting channel when you are unsure which
component is affected.
