export interface Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}
export interface Point {
    x: number;
    y: number;
}
export declare function applyToPoint(matrix: Matrix, point: Point): Point;
export declare function inverse(matrix: Matrix): Matrix;
export declare function scale(sx: number, sy: number): Matrix;
export declare function translate(tx: number, ty: number): Matrix;
export declare function transform(...matrices: Matrix[]): Matrix;
//# sourceMappingURL=matrix.d.ts.map