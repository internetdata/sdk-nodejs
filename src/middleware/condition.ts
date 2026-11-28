import { HELD_FLAGS, type Result } from '../types.js';

/**
 * A bound on a numeric member. Every key present must hold, so
 * `{ gte: 5, lt: 100 }` is a range.
 */
export interface NumericBound {
    gte?: number;
    gt?: number;
    lte?: number;
    lt?: number;
}

type LeafCondition<T> =
    T extends number ? number | number[] | NumericBound
        : T extends string ? string | string[]
            : T extends boolean ? boolean
                : never;

// A member the answer holds as a list (`web`'s rows, `pubproxy.protocols`) takes
// a condition on one element, which matches when any element does.
type MemberCondition<V> =
    V extends readonly (infer E)[] ? MemberCondition<NonNullable<E>>
        : V extends object ? ConditionOn<V>
            : LeafCondition<V> | false | null;

type ConditionOn<T> = {
    [K in keyof T]?: MemberCondition<NonNullable<T[K]>>;
};

/**
 * What makes a request worth blocking, written in the shape of a `Result`.
 *
 * Only the members you name are considered, and they must all hold. A member
 * set to `false` or `null` is ignored entirely - a condition states the
 * positive signals you act on, so there is no way to write "block when this is
 * false", which would otherwise read as blocking everybody.
 *
 * ```ts
 * { location: { country: ['CU', 'IR', 'KP'] } }
 * { isHosting: true, asn: { type: 'hosting' } }
 * { isResproxy: true, resproxy: { hits: { gte: 5 } } }
 * ```
 *
 * A list means OR, so any one of its entries blocking is enough. A member the
 * answer holds as a list matches when any one element does, every member of an
 * object term on the same element: `{ web: { port: 443 } }`,
 * `{ pubproxy: { protocols: 'socks5' } }`.
 */
export type BlockCondition = ConditionOn<Omit<Result, 'raw'>>;

/** Whether an answer satisfies the condition, and should therefore be blocked. */
export function matchesCondition(
    condition: BlockCondition | BlockCondition[], result: Result,
): boolean {
    const any = Array.isArray(condition) ? condition : [condition];
    return any.some((one) => matchesObject(
        one as Record<string, unknown>, result as unknown as Record<string, unknown>,
    ));
}

/**
 * The members a condition names that this answer did not carry: a top-level
 * member, or a paid one inside an object every plan gets, by its path
 * (`location.city`).
 *
 * A field your plan does not include is absent rather than false, so a
 * condition naming one can never match and the block would silently never
 * fire. An empty object is a real answer, meaning the flag above it is false,
 * so nothing inside one is reported: `vpn` present but `{}` is not a plan gap.
 * A populated object carries every member the plan includes, so a member
 * missing there is one.
 *
 * A locally answered bogon reports nothing missing: it is synthesized in the
 * widest shape, so every member is present but a user agent's verdict, which
 * the API answers for a bogon and the client does not, and which no plan gap
 * explains. The corpus pins the rest, because narrowing the synthesized shape
 * would start reporting a plan gap on every private address.
 */
export function missingMembers(
    condition: BlockCondition | BlockCondition[], result: Result,
): string[] {
    if (result.isBogon) {
        return [];
    }
    const any = Array.isArray(condition) ? condition : [condition];
    const missing = new Set<string>();
    const answer = result as unknown as Record<string, unknown>;
    // A held flag reads false when the API did not send it, so its presence is the wire answer's.
    const wire = isRecord(answer['raw']) ? answer['raw'] : undefined;
    for (const one of any) {
        collectMissing(one as Record<string, unknown>, answer, '', missing, wire);
    }
    return [...missing];
}

/**
 * How many leaf constraints a condition actually carries.
 *
 * Callers use this to reject a condition that constrains nothing: with every
 * entry ignored there is nothing left to satisfy, so it would match every
 * answer and block all traffic. Nobody writes that on purpose, and failing at
 * construction beats discovering it in production.
 */
export function constraintCount(condition: unknown): number {
    if (condition === false || condition === null || condition === undefined) {
        return 0;
    }
    if (Array.isArray(condition)) {
        return condition.reduce<number>((n, entry) => n + constraintCount(entry), 0);
    }
    if (isNumericBound(condition)) {
        return 1;
    }
    if (typeof condition === 'object') {
        return Object.values(condition).reduce<number>((n, v) => n + constraintCount(v), 0);
    }
    return 1;
}

function collectMissing(
    condition: Record<string, unknown>, value: Record<string, unknown>, prefix: string,
    missing: Set<string>, wire?: Record<string, unknown>,
) {
    for (const [member, want] of Object.entries(condition)) {
        if (constraintCount(want) === 0) {
            continue;
        }
        const path = `${prefix}${member}`;
        if (!(member in value) || notSent(member, wire)) {
            missing.add(path);
            continue;
        }
        const got = value[member];
        if (isRecord(want) && !isNumericBound(want) && isRecord(got) && Object.keys(got).length > 0) {
            collectMissing(want, got, `${path}.`, missing);
        }
    }
}

// The wire is given for the top level alone, where the held flags are.
function notSent(member: string, wire: Record<string, unknown> | undefined): boolean {
    return wire !== undefined && Object.hasOwn(HELD_FLAGS, member) && !(HELD_FLAGS[member]! in wire);
}

function matchesObject(
    condition: Record<string, unknown>, value: Record<string, unknown>,
): boolean {
    for (const [key, want] of Object.entries(condition)) {
        if (constraintCount(want) === 0) {
            continue;
        }
        if (!(key in value) || !matchesValue(want, value[key])) {
            return false;
        }
    }
    return true;
}

function matchesValue(want: unknown, got: unknown): boolean {
    // Through 2.16 a term on a list member compared the list itself, so it never matched.
    if (Array.isArray(got)) {
        return got.some((element) => matchesValue(want, element));
    }
    if (Array.isArray(want)) {
        return want.some((entry) => matchesValue(entry, got));
    }
    if (isNumericBound(want)) {
        return matchesBound(want, got);
    }
    if (typeof want === 'object' && want !== null) {
        return isRecord(got) && matchesObject(want as Record<string, unknown>, got);
    }
    // Providers are lowercase slugs and countries uppercase codes on the wire,
    // and a caller should not have to know which, so a string compares without case.
    if (typeof want === 'string' && typeof got === 'string') {
        return want.toLowerCase() === got.toLowerCase();
    }
    return want === got;
}

function matchesBound(bound: NumericBound, got: unknown): boolean {
    if (typeof got !== 'number') {
        return false;
    }
    if (bound.gte !== undefined && got < bound.gte) {
        return false;
    }
    if (bound.gt !== undefined && got <= bound.gt) {
        return false;
    }
    if (bound.lte !== undefined && got > bound.lte) {
        return false;
    }
    if (bound.lt !== undefined && got >= bound.lt) {
        return false;
    }
    return true;
}

const BOUND_KEYS = ['gte', 'gt', 'lte', 'lt'];

function isNumericBound(value: unknown): value is NumericBound {
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((k) => BOUND_KEYS.includes(k));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
