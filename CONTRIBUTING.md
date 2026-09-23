# Contributing

This repo is optimised for a fast-moving hackathon team.

## Workflow

1. Pick or create a GitHub Issue.
2. Branch from `develop`.
3. Use `feature/<name>`, `fix/<name>` or `docs/<name>`.
4. Keep commits small and descriptive.
5. Open a PR into `develop`.
6. Link the issue and include screenshots for UI work.
7. Before demo freeze, merge tested `develop` changes into `main`.

## Definition of done

A task is done when:
- the happy path works;
- failure/loading/empty states are handled where relevant;
- no secrets or private datasets are committed;
- setup/config changes are documented;
- the feature supports the agreed demo story;
- another teammate can run or review it.

## PR guidance

Prefer small PRs. Include:
- what changed;
- why it matters to the hackathon story;
- how to test it;
- screenshots/video for visible changes;
- known limitations.

## Fast decisions

When time is tight, optimise for:
1. working end-to-end demo;
2. judge-visible value;
3. reliability;
4. polish;
5. optional depth.

Document irreversible or architecture-changing decisions in `docs/DECISIONS.md`.
