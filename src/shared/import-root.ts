// The panel's import retry rule (M1.5): a 400 from POST /api/boards/import asks the person for a
// root only when no usable root was the cause. A file that is not valid (for example a
// project_root field of the wrong type) is a plain failure: a typed root cannot fix it.

/** The texts that mean "give a root": importRoot's two ImportErrors and the checkRootArg rule. */
const NEEDS_ROOT = /— pass project_root$|^project_root must be an existing absolute directory/;

/** True when an import response asks for a project root, so the panel prompts and retries. */
export function importNeedsRoot(status: number, error: string | undefined): boolean {
  return status === 400 && NEEDS_ROOT.test(error ?? "");
}
