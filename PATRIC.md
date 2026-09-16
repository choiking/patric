# Patric Project Instructions

## Code Style
- Use 2-space indentation for TypeScript files
- Prefer `const` over `let` whenever possible
- Keep functions under 50 lines where practical

## Architecture
- Organize modules by responsibility: `src/core/`, `src/cli/`, `src/desktop/`, `src/browser/`, and `src/config/`
- CLI and desktop depend on the shared core; core, browser, and config modules must not import either UI
- Keep model requests and tool behavior in the shared core; interface adapters own presentation and input
- Keep tests beside the modules they exercise
- Split large modules by responsibility, keeping behavior unchanged during structural refactors
- Export interfaces from the module that defines them
- Use `.js` extensions in import paths (ESM requirement)

## Git Conventions
- Commit messages should start with a type: feat, fix, refactor, docs, chore
- Keep commits focused on a single change

## Testing
- Run `bun run check` before committing to verify nothing is broken
- Test new features manually in both interactive and one-shot modes
