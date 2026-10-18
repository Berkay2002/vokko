# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a vulnerability.

Include what you found, the affected component (server, gateway, desktop shell, a bot integration), the version or commit, and steps to reproduce. We will acknowledge the report, work on a fix, and credit you in the release notes if you wish.

## Scope

In scope: the `vokko-server` REST API and gateway (authentication, permissions, rate limiting, uploads, link-preview fetching), the web and desktop clients, and the bots and integrations in this repository.

Out of scope: problems in a self-hosted deployment's own configuration (exposed database, missing HTTPS), and findings that need a malicious server administrator.

## Supported versions

Vokko is pre-1.0. Only the latest release and the `main` branch receive fixes.
