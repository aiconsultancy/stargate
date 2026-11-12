.DEFAULT_GOAL := help

MISE ?= mise
ARGS ?=

TASKS := deps pogo init crew-init provision cua-install cua start \
	config-check manifest service check test test-release-env eval \
	typecheck lint format \
	hooks-install hooks workflow-check

.PHONY: help $(TASKS)

help:
	@printf '%s\n' \
	  'Pogo commands (Make delegates to mise):' \
	  '  make deps          Install locked dependencies' \
	  '  make init          Start the Slack setup wizard' \
	  '  make crew-init     Install the default OpenCode captain/crew profile' \
	  '  make provision     Plan or resume a batch of Slack registrations' \
	  '  make cua-install   Install the optional portable browser driver' \
	  '  make cua ARGS="--help"     Run the browser driver' \
	  '  make start         Run configured bots' \
	  '  make config-check  Validate config and token references' \
	  '  make manifest      Generate the Slack app manifest' \
	  '  make service ARGS="status"  Manage the user service' \
	  '  make pogo ARGS="--help"    Run any CLI command' \
	  '  make check         Run typecheck, lint, and tests' \
	  '  make eval          Run local conversation reliability evaluations' \
	  '  make test | typecheck | lint | format' \
	  '  make test-release-env  Run tests as a self-update does (hidden TMPDIR)' \
	  '  make hooks-install Install prek pre-commit hooks' \
	  '  make hooks         Run all pre-commit checks' \
	  '  make workflow-check Validate GitHub Actions workflows' \
	  '' \
	  'Forward options with ARGS, e.g.:' \
	  '  make config-check ARGS="--config pogo.example.json --schema-only"' \
	  'Never pass secret values through ARGS; use the wizard or environment.'

$(TASKS):
	@"$(MISE)" run "$@" -- $(ARGS)
