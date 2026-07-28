import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**"],
	},
	js.configs.recommended,
	// Type-aware, so that the rules the plugin guidelines care about most -
	// unawaited promises above all - can actually be checked.
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			"no-prototype-builtins": "off",
			// Obsidian's plugin guidelines: keep the shared console clean.
			"no-console": ["error", { allow: ["error"] }],
		},
	},
	{
		// Build scripts are plain Node ESM, outside the TypeScript project.
		files: ["*.mjs"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			globals: { process: "readonly" },
		},
	},
);
