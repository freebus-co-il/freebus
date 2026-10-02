# Security Policy

## Supported Versions

FreeBus is deployed as a single rolling release — one production box running
whatever is on `main`. There are no maintained release branches or version
numbers to choose between, so security fixes are made against `main` and
deployed immediately; there is no older version that continues to receive
patches.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.** A public
report gives anyone watching the repository a working exploit before a fix
can be deployed.

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and its impact.

This opens a private conversation with the maintainer that nobody else can
see, and lets you track the fix through to a published advisory if one is
warranted.

If you are unable to use that flow for any reason, contact the maintainer,
[@ShalomSagi](https://github.com/ShalomSagi), privately through GitHub.

You can expect an initial response within a few days. There is no bug bounty
— this is an unfunded open-source project — but genuine reports are taken
seriously and credited in the resulting advisory unless you ask otherwise.

## Scope

This project talks to several third-party and self-hosted services
(Valhalla, Photon, the Israel MOT GTFS feed, optionally Google Maps). A
vulnerability in one of those upstream projects should be reported to its own
maintainers; a vulnerability in how this repository configures, deploys, or
calls them belongs here.
