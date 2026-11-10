import { describe, expect, it } from 'vitest';
import { FUNCTION_LIST } from './functions.ts';
import { calc } from './testkit.ts';

const nums = { A1: '1', A2: '2', A3: '3', A4: 'text', A5: 'TRUE', A6: '' };

describe('aggregates', () => {
  it('ignore text and booleans in ranges but coerce direct arguments', () => {
    expect(calc('=SUM(A1:A6)', nums)).toBe(6);
    expect(calc('=SUM(A4)', nums)).toBe(0);
    expect(calc('=SUM("3",TRUE)', nums)).toBe(4);
    expect(calc('=SUM("x")')).toBe('#VALUE!');
    expect(calc('=AVERAGE(A1:A6)', nums)).toBe(2);
    expect(calc('=AVERAGE(A6)', nums)).toBe('#DIV/0!');
    expect(calc('=COUNT(A1:A6)', nums)).toBe(3);
    expect(calc('=COUNTA(A1:A6)', nums)).toBe(5);
    expect(calc('=COUNTBLANK(A1:A8)', nums)).toBe(3);
    expect(calc('=MIN(A1:A6)', nums)).toBe(1);
    expect(calc('=MAX(A1:A6,10)', nums)).toBe(10);
    expect(calc('=PRODUCT(A1:A3,2)', nums)).toBe(12);
  });

  it('propagate errors from ranges', () => {
    expect(calc('=SUM(A1:A2)', { A1: '1', A2: '=1/0' })).toBe('#DIV/0!');
    expect(calc('=COUNT(A1:A2)', { A1: '1', A2: '=1/0' })).toBe(1);
  });

  it('work on whole columns without visiting a million cells', () => {
    const cells: Record<string, string> = {};
    for (let i = 1; i <= 5000; i++) cells[`A${i}`] = String(i);
    expect(calc('=SUM(A:A)', cells)).toBe((5000 * 5001) / 2);
    expect(calc('=COUNTBLANK(A:A)', cells)).toBe(1_048_576 - 5000);
    expect(calc('=COUNTIF(A:A,">4990")', cells)).toBe(10);
    expect(calc('=COUNTIF(A:A,"")', cells)).toBe(1_048_576 - 5000);
  });

  it('statistics', () => {
    const c = { A1: '2', A2: '4', A3: '4', A4: '4', A5: '5', A6: '5', A7: '7', A8: '9' };
    expect(calc('=STDEV.P(A1:A8)', c)).toBe(2);
    expect(calc('=MEDIAN(A1:A8)', c)).toBe(4.5);
    expect(calc('=LARGE(A1:A8,2)', c)).toBe(7);
    expect(calc('=SMALL(A1:A8,1)', c)).toBe(2);
    expect(calc('=RANK(7,A1:A8)', c)).toBe(2);
    expect(calc('=RANK(4,A1:A8,1)', c)).toBe(2);
    expect(calc('=VAR.S(1,2,3,4)')).toBeCloseTo(1.6666666667);
  });
});

describe('math', () => {
  it('rounds half away from zero, without float surprises', () => {
    expect(calc('=ROUND(2.5,0)')).toBe(3);
    expect(calc('=ROUND(-2.5,0)')).toBe(-3);
    expect(calc('=ROUND(1.005,2)')).toBe(1.01);
    expect(calc('=ROUND(1234.5678,-2)')).toBe(1200);
    expect(calc('=ROUNDUP(1.21,1)')).toBe(1.3);
    expect(calc('=ROUNDDOWN(-1.29,1)')).toBe(-1.2);
    expect(calc('=INT(-1.5)')).toBe(-2);
    expect(calc('=TRUNC(-1.5)')).toBe(-1);
  });

  it('MOD takes the sign of the divisor', () => {
    expect(calc('=MOD(-3,2)')).toBe(1);
    expect(calc('=MOD(3,-2)')).toBe(-1);
    expect(calc('=MOD(1,0)')).toBe('#DIV/0!');
  });

  it('domain errors', () => {
    expect(calc('=SQRT(-1)')).toBe('#NUM!');
    expect(calc('=LN(0)')).toBe('#NUM!');
    expect(calc('=1/0')).toBe('#DIV/0!');
    expect(calc('=0^0')).toBe('#NUM!');
    expect(calc('=10^400')).toBe('#NUM!');
    expect(calc('=CEILING(4.1,0.5)')).toBe(4.5);
    expect(calc('=FLOOR(4.9,2)')).toBe(4);
    expect(calc('=FACT(5)')).toBe(120);
  });
});

describe('logic', () => {
  it('IF is lazy: the branch not taken is never evaluated', () => {
    expect(calc('=IF(TRUE,1,1/0)')).toBe(1);
    expect(calc('=IF(1>2,"yes")')).toBe(false);
    expect(calc('=IFERROR(1/0,"oops")')).toBe('oops');
    expect(calc('=IFERROR(5,"oops")')).toBe(5);
    expect(calc('=IFNA(NA(),"none")')).toBe('none');
    expect(calc('=IFNA(1/0,"none")')).toBe('#DIV/0!');
    expect(calc('=IFS(1>2,"a",2>1,"b")')).toBe('b');
    expect(calc('=IFS(FALSE,1)')).toBe('#N/A');
    expect(calc('=CHOOSE(2,"a","b","c")')).toBe('b');
    expect(calc('=SWITCH(3,1,"one",3,"three","other")')).toBe('three');
    expect(calc('=SWITCH(9,1,"one","other")')).toBe('other');
  });

  it('AND / OR / XOR / NOT', () => {
    expect(calc('=AND(TRUE,1,A1:A2)', { A1: 'TRUE', A2: 'text' })).toBe(true);
    expect(calc('=OR(FALSE,0)')).toBe(false);
    expect(calc('=XOR(TRUE,TRUE,TRUE)')).toBe(true);
    expect(calc('=NOT(0)')).toBe(true);
    expect(calc('=AND(A1)', { A1: 'x' })).toBe('#VALUE!');
  });

  it('compares like Excel: case-insensitive text, numbers < text < booleans', () => {
    expect(calc('="abc"="ABC"')).toBe(true);
    expect(calc('=1<"a"')).toBe(true);
    expect(calc('="z"<TRUE')).toBe(true);
    expect(calc('=A1=0', { B1: '1' })).toBe(true);
    expect(calc('=A1=""', { B1: '1' })).toBe(true);
    expect(calc('="10"+1')).toBe(11);
    expect(calc('="ten"+1')).toBe('#VALUE!');
  });
});

describe('text', () => {
  it('slices, searches and joins', () => {
    expect(calc('=LEFT("Tbilisi",3)')).toBe('Tbi');
    expect(calc('=RIGHT("Tbilisi",2)')).toBe('si');
    expect(calc('=MID("Tbilisi",2,4)')).toBe('bili');
    expect(calc('=LEN("ქართული")')).toBe(7);
    expect(calc('=UPPER("abc")&LOWER("DEF")')).toBe('ABCdef');
    expect(calc('=PROPER("hello wORLD")')).toBe('Hello World');
    expect(calc('=TRIM("  a   b  ")')).toBe('a b');
    expect(calc('=SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(calc('=SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c');
    expect(calc('=FIND("b","abcb")')).toBe(2);
    expect(calc('=FIND("B","abcb")')).toBe('#VALUE!');
    expect(calc('=SEARCH("B?","abcb")')).toBe(2);
    expect(calc('=REPT("ab",3)')).toBe('ababab');
    expect(calc('=EXACT("a","A")')).toBe(false);
    expect(calc('=VALUE("1,234.5")')).toBe(1234.5);
    expect(calc('=CONCAT(A1:B2)', { A1: 'a', B1: 'b', B2: 'd' })).toBe('abd');
    expect(calc('=TEXTJOIN(", ",TRUE,A1:A3)', { A1: 'x', A3: 'z' })).toBe('x, z');
    expect(calc('=TEXTJOIN("-",FALSE,A1:A3)', { A1: 'x', A3: 'z' })).toBe('x--z');
  });

  it('formats numbers with TEXT', () => {
    expect(calc('=TEXT(1234.567,"#,##0.00")')).toBe('1,234.57');
    expect(calc('=TEXT(0.256,"0.0%")')).toBe('25.6%');
    expect(calc('=TEXT(5,"000")')).toBe('005');
    expect(calc('=TEXT(1234.5,"$#,##0")')).toBe('$1,235');
    expect(calc('=TEXT(-3.14159,"0.00")')).toBe('-3.14');
  });

  it('turns numbers into text the way they are displayed', () => {
    expect(calc('=1/3&""')).toBe('0.3333333333');
    expect(calc('=TRUE&"!"')).toBe('TRUE!');
  });
});

describe('lookup', () => {
  const table = {
    A1: 'apple', B1: '1.2',
    A2: 'banana', B2: '0.5',
    A3: 'cherry', B3: '3',
    D1: '0', E1: 'F',
    D2: '60', E2: 'D',
    D3: '70', E3: 'C',
    D4: '80', E4: 'B',
    D5: '90', E5: 'A',
  };

  it('VLOOKUP, exact and approximate', () => {
    expect(calc('=VLOOKUP("banana",A1:B3,2,FALSE)', table)).toBe(0.5);
    expect(calc('=VLOOKUP("BAN*",A1:B3,2,FALSE)', table)).toBe(0.5);
    expect(calc('=VLOOKUP("kiwi",A1:B3,2,FALSE)', table)).toBe('#N/A');
    expect(calc('=VLOOKUP(85,D1:E5,2)', table)).toBe('B');
    expect(calc('=VLOOKUP(90,D1:E5,2,TRUE)', table)).toBe('A');
    expect(calc('=VLOOKUP(-1,D1:E5,2)', table)).toBe('#N/A');
    expect(calc('=VLOOKUP("apple",A1:B3,3,FALSE)', table)).toBe('#REF!');
    expect(calc('=VLOOKUP("cherry",A:B,2,FALSE)', table)).toBe(3);
  });

  it('HLOOKUP, MATCH and INDEX', () => {
    expect(calc('=HLOOKUP("b",A1:C2,2,FALSE)', { A1: 'a', B1: 'b', C1: 'c', A2: '1', B2: '2', C2: '3' })).toBe(2);
    expect(calc('=MATCH("cherry",A1:A3,0)', table)).toBe(3);
    expect(calc('=MATCH(75,D1:D5)', table)).toBe(3);
    expect(calc('=MATCH(75,D1:D5,0)', table)).toBe('#N/A');
    expect(calc('=INDEX(A1:B3,2,1)', table)).toBe('banana');
    expect(calc('=INDEX(A1:A3,3)', table)).toBe('cherry');
    expect(calc('=INDEX(A1:B3,4,1)', table)).toBe('#REF!');
    expect(calc('=INDEX(B1:B3,MATCH("cherry",A1:A3,0))', table)).toBe(3);
  });

  it('XLOOKUP with fallback, match modes and reverse search', () => {
    expect(calc('=XLOOKUP("cherry",A1:A3,B1:B3)', table)).toBe(3);
    expect(calc('=XLOOKUP("kiwi",A1:A3,B1:B3,"none")', table)).toBe('none');
    expect(calc('=XLOOKUP(75,D1:D5,E1:E5,,-1)', table)).toBe('C');
    expect(calc('=XLOOKUP(75,D1:D5,E1:E5,,1)', table)).toBe('B');
    expect(calc('=XLOOKUP("x",A1:A4,B1:B4,,0,-1)', { A1: 'x', B1: '1', A2: 'y', A4: 'x', B4: '4' })).toBe(4);
  });

  it('ROW, COLUMN, ROWS, COLUMNS', () => {
    expect(calc('=ROW()')).toBe(1000);
    expect(calc('=COLUMN()')).toBe(702);
    expect(calc('=ROW(C7)+COLUMN(C7)')).toBe(10);
    expect(calc('=ROWS(A1:B10)*COLUMNS(A1:B10)')).toBe(20);
  });
});

describe('conditional aggregates', () => {
  const sales = {
    A1: 'North', B1: 'Paid', C1: '100',
    A2: 'South', B2: 'Due', C2: '250',
    A3: 'North', B3: 'Due', C3: '75',
    A4: 'North', B4: 'Paid', C4: '20',
    A5: 'East', B5: '', C5: '5',
  };
  it('criteria: equality, operators, wildcards and blanks', () => {
    expect(calc('=SUMIF(A1:A5,"North",C1:C5)', sales)).toBe(195);
    expect(calc('=SUMIF(C1:C5,">50")', sales)).toBe(425);
    expect(calc('=SUMIF(C1:C5,"<>100")', sales)).toBe(350);
    expect(calc('=COUNTIF(A1:A5,"n*")', sales)).toBe(3);
    expect(calc('=COUNTIF(A1:A5,"?????")', sales)).toBe(4);
    expect(calc('=COUNTIF(B1:B5,"")', sales)).toBe(1);
    expect(calc('=COUNTIF(B1:B5,"<>")', sales)).toBe(4);
    expect(calc('=AVERAGEIF(A1:A5,"North",C1:C5)', sales)).toBe(65);
    expect(calc('=SUMIFS(C1:C5,A1:A5,"North",B1:B5,"Paid")', sales)).toBe(120);
    expect(calc('=COUNTIFS(A1:A5,"North",C1:C5,">=75")', sales)).toBe(2);
    expect(calc('=MAXIFS(C1:C5,B1:B5,"Due")', sales)).toBe(250);
    expect(calc('=MINIFS(C1:C5,A1:A5,"North")', sales)).toBe(20);
    expect(calc('=AVERAGEIFS(C1:C5,B1:B5,"Due")', sales)).toBe(162.5);
    expect(calc('=SUMPRODUCT(C1:C3,C1:C3)', sales)).toBe(100 * 100 + 250 * 250 + 75 * 75);
  });
});

describe('information', () => {
  it('IS functions never let an error escape', () => {
    expect(calc('=ISERROR(1/0)')).toBe(true);
    expect(calc('=ISNA(NA())')).toBe(true);
    expect(calc('=ISBLANK(A1)')).toBe(true);
    expect(calc('=ISNUMBER(A1)', { A1: '3' })).toBe(true);
    expect(calc('=ISTEXT(A1)', { A1: 'x' })).toBe(true);
    expect(calc('=ISLOGICAL(1=1)')).toBe(true);
  });
});

describe('finance', () => {
  it('matches the textbook values', () => {
    // $200,000 over 30 years at 6% a year, paid monthly.
    expect(calc('=PMT(6%/12,360,200000)')).toBeCloseTo(-1199.1010503, 6);
    expect(calc('=FV(5%,10,-100)')).toBeCloseTo(1257.78925, 4);
    expect(calc('=PV(5%,10,-100)')).toBeCloseTo(772.17349, 4);
    expect(calc('=NPER(1%,-100,1000)')).toBeCloseTo(10.5886, 4);
    expect(calc('=RATE(360,-1199.10105,200000)*12')).toBeCloseTo(0.06, 6);
    expect(calc('=NPV(10%,-1000,300,400,500)')).toBeCloseTo(-19.1244, 3); // the first flow is discounted too
    expect(calc('=IRR(A1:A4)', { A1: '-1000', A2: '300', A3: '400', A4: '500' })).toBeCloseTo(0.0889633947, 8);
    expect(calc('=IRR(A1:A2)', { A1: '1', A2: '2' })).toBe('#NUM!');
  });
});

describe('the library', () => {
  it('reports unknown functions and wrong argument counts', () => {
    expect(calc('=NOPE(1)')).toBe('#NAME?');
    expect(calc('=undefinedname+1')).toBe('#NAME?');
    expect(calc('=ROUND()')).toBe('#ERROR!');
    expect(calc('=ABS(1,2)')).toBe('#ERROR!');
  });

  it('documents every function', () => {
    expect(FUNCTION_LIST.length).toBeGreaterThan(80);
    for (const f of FUNCTION_LIST) {
      expect(f.desc.length, f.name).toBeGreaterThan(5);
      expect(f.min).toBeLessThanOrEqual(f.max);
    }
  });
});
