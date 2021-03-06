import { Neo4j } from "../../deps.ts";

const DAYS_PER_MONTH = Object.freeze([
    /* Jan */ 31,    undefined, /* Mar */ 31, /* Apr */ 30, /* May */ 31, /* Jun */ 30,
    /* Jul */ 31, /* Aug */ 31, /* Sep */ 30, /* Oct */ 31, /* Nov */ 30, /* Dec */ 31,
]);

function isLeapYear(year: number): boolean {
    return (year % 4 === 0) && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * A calendar date (a date without any time).
 * 
 * You should never use JavaScript's built-in "Date()" type for representing calendar dates, because it only works if
 * you are extremely careful to always use UTC.
 * 
 * e.g. on my system, new Date("2021-03-01").toString() gives "Feb 28 2021..." - the date "March 1" has been
 *      accidentally changed to "Feb 28" through code that looks perfectly reasonable.
 *
 * This subclasses the Neo4j "Date" type and is compatible with it, but has three extra features:
 * 1) Serializes to JSON as a standard ISO 8601 string, as you would expect
 * 2) Has a fromString() method to de-serialize from an ISO 8601 string, as you would expect
 * 3) Rejects invalid dates like "February 31"
 */
export class VDate extends Neo4j.Date<number> {

    constructor(y: number, m: number, d: number) {
        super(y, m, d);
        // Superclass validates year, month, and day are within allowed ranges but doesn't check if "day" is valid for
        // the given month, so check that now:
        const maxDaysPerMonth = DAYS_PER_MONTH[m - 1] ?? (isLeapYear(y) ? 29 : 28);
        if (d > maxDaysPerMonth) { throw new Error(`Invalid date`); }
    }

    /**
     * Construct a VDate from an ISO 8601 date string "YYYY-MM-DD" or "YYYYMMDD"
     * @param {string} str - An ISO 8601 date string
     * @returns {PDate}
     */
    public static fromString(str: string): VDate {
        const year = parseInt(str.substr(0, 4), 10);
        let month = NaN;
        let day = NaN;
        if (str.length === 10 && str.charAt(4) === "-" && str.charAt(7) === "-") {
            // YYYY-MM-DD format, presumably:
            month = parseInt(str.substr(5, 2), 10);
            day = parseInt(str.substr(8, 2), 10);
        } else if (str.length === 8 && String(parseInt(str, 10)) === str) {
            // YYYYMMDD format, presumably.
            // (Note we check 'String(parseInt(str, 10)) === str' to avoid matching things like '05/05/05')
            month = parseInt(str.substr(4, 2), 10);
            day = parseInt(str.substr(6, 2), 10);
        }
        if (isNaN(year) || isNaN(month) || isNaN(day)) {
            throw new Error("Date string not in YYYY-MM-DD or YYYYMMDD format");
        }
        return new VDate(year, month, day);
    }
    static fromNeo4jDate(date: Neo4j.Date<bigint|number>): VDate {
        const isUsingBigInt = (d: Neo4j.Date<bigint|number>): d is Neo4j.Date<bigint> => typeof d.year === "bigint";
        const isUsingNumber = (d: Neo4j.Date<bigint|number>): d is Neo4j.Date<number> => typeof d.year === "number";
        if (isUsingBigInt(date)) {
            return new VDate(Number(date.year), Number(date.month), Number(date.day));
        } else if (isUsingNumber(date)) {
            return new VDate(date.year, date.month, date.day);
        }
        throw new Error(`Unknown Neo4j date type (${date}) or using unsupported integer type.`);
    }
    static fromStandardDate(standardDate: Date): VDate { return this.fromNeo4jDate(Neo4j.Date.fromStandardDate(standardDate)); }

    public toJSON(): string { return this.toString(); }

    /**
     * Parse a template string literal, e.g. const VD = VDate.parseTemplateLiteral; const date1 = VD`2016-01-01`;
     */
    public static parseTemplateLiteral(strings: TemplateStringsArray, ...keys: unknown[]): VDate {
        return VDate.fromString(String.raw(strings, ...keys));
    }
}

export const VD = VDate.parseTemplateLiteral;
