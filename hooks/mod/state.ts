// Constants that more than one file of the mod uses.
//
// The $.state atoms are not here: `claude plugin validate` reads each state
// reference in the file that uses it, so each file declares its own atoms
// (the same plugin and key in each). contract.d.ts declares their types.

export const PANE = "inkwire";
export const DEFAULT_PORT = 4691;
