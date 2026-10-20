/** Bun loads `import x from "./file.md" with { type: "text" }` as the file's contents. */
declare module "*.md" {
	const content: string;
	export default content;
}
