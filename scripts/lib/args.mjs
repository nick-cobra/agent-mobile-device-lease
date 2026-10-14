export function makeArgReader(argv) {
  return {
    argValue(name, fallback) {
      const index = argv.indexOf(name);
      return index === -1 ? fallback : (argv[index + 1] ?? fallback);
    },
    hasArg(name) { return argv.includes(name); },
  };
}
