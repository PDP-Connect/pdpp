function moduleSpecifier(base: string, name: string): string {
  return `${base}/${name}`;
}

export async function loadModule(base: string, name: string): Promise<unknown> {
  return await import(moduleSpecifier(base, name));
}
