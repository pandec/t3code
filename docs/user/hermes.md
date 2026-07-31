# Hermes

Hermes is available as an early-access ACP provider in this fork.

Enable a Hermes provider instance in Settings on the machine where the `hermes` CLI is installed.
The optional, default-off **Require local gateway** switch can use the gateway as a machine-identity
marker when Hermes is meant to run on only one host. T3 Code discovers Hermes models, slash
commands, and skills from that local installation. Hermes authentication remains owned by the CLI.
