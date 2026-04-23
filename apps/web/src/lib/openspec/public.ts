export const PLANNING_LABEL = 'Planning';
export const PLANNING_BASE_PATH = '/planning';
export const OPENSPEC_IMPLEMENTATION_LABEL = 'OpenSpec';

export function planningPath(pathname = ''): string {
  if (!pathname || pathname === '/') return PLANNING_BASE_PATH;
  return `${PLANNING_BASE_PATH}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
