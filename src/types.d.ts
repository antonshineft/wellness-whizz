declare module '*.sql' {
  const sql: string;
  export default sql;
}
declare module '*.json' {
  const value: unknown;
  export default value;
}
