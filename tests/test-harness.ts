let failures = 0;

export function test(name: string, run: () => void): void {
    try {
        run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}`);
        console.error(error);
    }
}

export function equal<T>(actual: T, expected: T): void {
    if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function throws(run: () => void, pattern: RegExp): void {
    try {
        run();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (pattern.test(message)) return;
        throw new Error(`Unexpected error: ${message}`);
    }
    throw new Error("Expected function to throw");
}

export function finish(): void {
    if (failures > 0) throw new Error(`${failures} test(s) failed`);
}
