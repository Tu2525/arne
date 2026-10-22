// compareVersions(a, b) -> -1 | 0 | 1, following semver precedence (build metadata ignored).
// satisfies(version, range) -> boolean. Ranges: exact, = > >= < <=, ~x.y.z, ^x.y.z,
// space = AND, || = OR. A prerelease version only satisfies a range if one of its comparators
// has the same major.minor.patch and is itself a prerelease.
// Not implemented yet.
export function compareVersions(a, b) {
  throw new Error('not implemented')
}
export function satisfies(version, range) {
  throw new Error('not implemented')
}
