.DEFAULT_GOAL := help

MISE ?= mise
ARGS ?=

TASKS := deps pogo init start config-check manifest service check test typecheck lint format

.PHONY: help $(TASKS)

help:
	@printf '%s\n' \
	  'Pogo commands (Make delegates to mise):' \
	  '  make deps          Install locked dependencies' \
	  '  make init          Start the Slack setup wizard' \
	  '  make start         Run configured bots' \
	  '  make config-check  Validate config and token references' \
	  '  make manifest      Generate the Slack app manifest' \
	  '  make service ARGS="status"  Manage the user service' \
	  '  make pogo ARGS="--help"    Run any CLI command' \
	  '  make check         Run typecheck, lint, and tests' \
	  '  make test | typecheck | lint | format' \
	  '' \
	  'Forward options with ARGS, e.g.:' \
	  '  make config-check ARGS="--config pogo.example.json --schema-only"' \
	  'Never pass secret values through ARGS; use the wizard or environment.'

$(TASKS):
	@"$(MISE)" run "$@" -- $(ARGS)
