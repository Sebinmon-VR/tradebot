// Type declarations for the template's web-only CSS imports.
declare module '*.module.css' { const classes: Record<string, string>; export default classes; }
declare module '*.css';
