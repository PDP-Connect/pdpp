declare module "express" {
  interface Request {
    body: Record<string, string | undefined>;
  }
  interface Response {
    redirect: (path: string) => void;
    send: (body: unknown) => void;
    setHeader: (name: string, value: string) => void;
  }
  type Handler = (request: Request, response: Response) => unknown;
  interface App {
    get: (path: string, handler: Handler) => void;
    listen: (port: number, callback: () => void) => { close: (callback?: () => void) => void };
    post: (path: string, handler: Handler) => void;
    use: (handler: unknown) => void;
  }
  type Express = (() => App) & {
    json: () => unknown;
    urlencoded: (options: { extended: boolean }) => unknown;
  };
  const express: Express;
  export default express;
}
