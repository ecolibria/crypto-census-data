#!/usr/bin/env node
/**
 * The four lines a test step's output opens with, on stdout and on stderr,
 * before any other byte of the step: the three lines that remove the problem
 * matchers actions/setup-node registers for the job (at 49933ea, the commit
 * the workflows pin, .github/tsc.json, eslint-stylish.json and
 * eslint-compact.json at src/main.ts:72-79), then `::stop-commands::<token>`.
 * The same text, in the same order, that scripts/validate-dataset.mjs writes
 * at its start, and for the same reasons: the runner keeps one stop state for
 * both streams and handles the stderr lines it has read first, so each stream
 * removes the three matchers before its own stop line.
 *
 * A test's name, or what a failing test prints, can hold text the runner
 * reads as a workflow command (`##[error]` anywhere in a line) or a matcher
 * reads as an error (`: line 1, col 2, Error - x (y)`), and the reporter
 * `node --test` defaults to off a terminal writes it as it is from Node 23 on.
 * From the stop line on, the runner acts on no command, and with the matchers
 * removed no line is read as an error or a warning. The token is 32 hex
 * characters drawn afresh for each run, so no line of the step can be
 * `::<token>::` by choice; nothing resumes commands, and the step stays
 * stopped to its end.
 *
 * Prints nothing else and exits 0. Run first in a step, before `node --test`:
 *
 *   node scripts/stop-commands.mjs && node --test scripts/check-errata.mjs
 */

import { randomBytes } from 'node:crypto';

const STOP_TOKEN = randomBytes(16).toString('hex');
const SETUP_NODE_MATCHERS = ['tsc', 'eslint-stylish', 'eslint-compact'];
const OPENING = `${SETUP_NODE_MATCHERS.map((owner) => `::remove-matcher owner=${owner}::\n`).join('')}::stop-commands::${STOP_TOKEN}\n`;
process.stdout.write(OPENING);
process.stderr.write(OPENING);
