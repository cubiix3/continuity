/**
 * Names never treated as project content, anywhere in a path: VCS and Continuity state, dependencies, build and cache
 * output, and secret-looking files. The source scanner skips them, and autosave does not count an edit to them.
 */
export const DENIED_NAME = /^(?:\.env(?:\..*)?|credentials.*|secrets.*|\.git|\.continuity|node_modules|dist|build|coverage|vendor|\.ssh|\.aws|\.venv|venv|\.next|\.cache)$|\.(?:pem|key|p12|pfx|db|sqlite|log)$/i;
/** A path relative to its project root with a denied component. */
export const deniedPath = (relativePath: string) => relativePath.split(/[\\/]/).some(part => DENIED_NAME.test(part));
