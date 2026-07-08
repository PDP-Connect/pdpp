export function applyToPoint(matrix, point) {
    return {
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    };
}
export function inverse(matrix) {
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (determinant === 0) {
        throw new Error("matrix is not invertible");
    }
    return {
        a: matrix.d / determinant,
        b: -matrix.b / determinant,
        c: -matrix.c / determinant,
        d: matrix.a / determinant,
        e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
        f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
    };
}
export function scale(sx, sy) {
    return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}
export function translate(tx, ty) {
    return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}
export function transform(...matrices) {
    const input = Array.isArray(matrices[0]) ? matrices[0] : matrices;
    if (input.length === 0) {
        throw new Error("no matrices provided");
    }
    if (input.length === 1) {
        return input[0];
    }
    const multiply = (left, right) => ({
        a: left.a * right.a + left.c * right.b,
        b: left.b * right.a + left.d * right.b,
        c: left.a * right.c + left.c * right.d,
        d: left.b * right.c + left.d * right.d,
        e: left.a * right.e + left.c * right.f + left.e,
        f: left.b * right.e + left.d * right.f + left.f,
    });
    return input.slice(1).reduce((acc, matrix) => multiply(acc, matrix), input[0]);
}
//# sourceMappingURL=matrix.js.map