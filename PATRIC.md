# Patric Project Instructions

## Code Style
- Use 2-space indentation for TypeScript files
- Prefer `const` over `let` whenever possible
- Keep functions under 50 lines where practical

## Architecture
- All new modules go in `src/` as flat files (no nested directories)
- Export interfaces from the module that defines them
- Use `.js` extensions in import paths (ESM requirement)

## Git Conventions
- Commit messages should start with a type: feat, fix, refactor, docs, chore
- Keep commits focused on a single change

## Testing
- Run `bun run check` before committing to verify nothing is broken
- Test new features manually in both interactive and one-shot modes
