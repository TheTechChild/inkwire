import { describe, expect, it } from "vitest";
import { blockText, findSymbol } from "../../src/core/symbols.js";

describe("findSymbol", () => {
  it("respects identifier boundaries", () => {
    expect(findSymbol("function getPath() {}", "get")).toBeNull();
    expect(findSymbol("const a = getPath();\nfunction get() {}", "get")).toEqual({ line: 2, end: 2 });
  });

  it("prefers a declaration over an earlier use or comment", () => {
    const t = "// calls foo here\nrun(foo);\nfunction foo() {\n  x;\n}\n";
    expect(findSymbol(t, "foo")).toEqual({ line: 3, end: 5 });
  });

  it.each([
    ["// see function foo below\nconst x = 1;\nfunction foo() {\n  y;\n}", "foo", 3, 5],
    ["function a() {\n  foo(1);\n}\nfunction foo(n) {\n  return n;\n}", "foo", 4, 6],
    ["foo(1);\nfunction foo(n) {\n  return n;\n}", "foo", 2, 4],
    ["class A {\n  x = mutate;\n  mutate = (a) => {\n    return a;\n  };\n}", "mutate", 3, 5],
    ["/**\n * foo(a) does a thing\n */\nconst foo = (a) => a;", "foo", 4, 4],
  ])("picks the declaration line: %#", (t, sym, line, end) => {
    expect(findSymbol(t, sym)).toEqual({ line, end });
  });

  it.each([
    ["Go method under a doc comment", "// Handle serves a request.\nfunc (s *Server) Handle(w W) {\n\tw.ok()\n}", "Handle", 2, 4],
    ["Kotlin fun under a comment", "// run does it\nfun run() {\n    x()\n}", "run", 2, 4],
    ["Java import then method", "import x.Run;\nclass A {\n    public void Run() {\n        body();\n    }\n}", "Run", 3, 5],
    [
      "TS overloads",
      "export function foo(a: string): void;\nexport function foo(a: number): void;\nexport function foo(a: any) {\n  body;\n}",
      "foo",
      3,
      5,
    ],
    ["Allman braces", "class A\n{\n    public void Run()\n    {\n        body();\n    }\n}", "Run", 3, 6],
    ["column-0 line inside a body", "function foo() {\n  const s = `\nhello\n`;\n  return s;\n}", "foo", 1, 6],
    ["keyword in a string", 'log("the function foo failed");\nconst foo = () => {\n  x;\n};', "foo", 2, 4],
    ["loop variable before the function", "for (const foo of xs) use(foo);\nfunction foo() {\n  y;\n}", "foo", 2, 4],
    ["import type is not a declaration", 'import type Foo from "./x";\nexport interface Foo {\n  a: 1;\n}', "Foo", 2, 4],
    ["generic type alias after a use", "function use(x: Result<number>) {}\nexport type Result<T> = Ok<T> | Err;", "Result", 2, 2],
    ["generic overload", "function foo<T>(a: T): void;\nfunction foo<T>(a: any) {\n  body;\n}", "foo", 2, 4],
  ])("%s", (_name, t, sym, line, end) => {
    expect(findSymbol(t, sym)).toEqual({ line, end });
  });

  it("falls back to the first match when nothing declares it", () => {
    expect(findSymbol("a;\nuse(foo);\nfoo;", "foo")).toEqual({ line: 2, end: 2 });
  });

  it("keeps a multi-line signature and its closing brace", () => {
    const t = "export function foo(\n  a,\n): X {\n  body;\n}\nconst z = 1;";
    expect(findSymbol(t, "foo")).toEqual({ line: 1, end: 5 });
  });

  it("finds a class method", () => {
    const t = "class A {\n  other() {\n    1;\n  }\n  handle(socket) {\n    2;\n  }\n}";
    expect(findSymbol(t, "handle")).toEqual({ line: 5, end: 7 });
  });

  it("ends a python def at the next def", () => {
    const t = "def a():\n    x = 1\n\n    return x\n\ndef b():\n    pass";
    expect(findSymbol(t, "a")).toEqual({ line: 1, end: 4 });
  });

  it("does not include the enclosing brace of a one-line const", () => {
    const t = "function f() {\n  const X = 5;\n}";
    expect(findSymbol(t, "X")).toEqual({ line: 2, end: 2 });
  });

  it("escapes regex metacharacters", () => {
    expect(findSymbol("let a;\nconst $store = 1;", "$store")).toEqual({ line: 2, end: 2 });
  });

  it("returns null when absent", () => {
    expect(findSymbol("nothing here", "foo")).toBeNull();
  });
});

describe("blockText", () => {
  it("ignores re-indent and blank lines", () => {
    const a = "function f() {\n  x;\n}";
    const b = "    function f() {\n\n        x;\n    }";
    expect(blockText(a, findSymbol(a, "f"))).toBe(blockText(b, findSymbol(b, "f")));
  });

  it("uses the whole text without a range", () => {
    expect(blockText("a\n\n  b\n", null)).toBe("a\nb");
  });
});
