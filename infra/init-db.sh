#!/bin/bash
# This runs inside the postgres container on first boot
# POSTGRES_DB env var already creates the DB, but this is a safety net
psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'agent_platform'" | grep -q 1 || psql -U postgres -c "CREATE DATABASE agent_platform"
