export function bulworkEnv(name: string): string | undefined {
  const bulworkVal = process.env[`BULWORK_${name}`];
  if (bulworkVal !== undefined) return bulworkVal;
  const brickVal = process.env[`BRICK_${name}`];
  if (brickVal !== undefined) {
    console.warn(`[bulwork] BRICK_${name} is deprecated, use BULWORK_${name} instead`);
    return brickVal;
  }
  return undefined;
}
