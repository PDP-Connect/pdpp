export class RemoteSurfaceProtocolError extends Error {
    path;
    constructor(message, path = "$") {
        super(`${path}: ${message}`);
        this.name = "RemoteSurfaceProtocolError";
        this.path = path;
    }
}
//# sourceMappingURL=errors.js.map