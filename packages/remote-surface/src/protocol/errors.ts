export class RemoteSurfaceProtocolError extends Error {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${path}: ${message}`);
    this.name = "RemoteSurfaceProtocolError";
    this.path = path;
  }
}
