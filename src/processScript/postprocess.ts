export const postprocess = (code: string, uniqueId: string) => code
	.replace(/^function\s*\w+\(/, `function(`)
	.replace(new RegExp(`\\$${uniqueId}\\$\\\\(?:\\\\)?\\$SC_DOLLAR\\$`, `g`), `S\\C$`)
	.replace(new RegExp(`\\$${uniqueId}\\$\\\\(?:\\\\)?\\$DB_DOLLAR\\$`, `g`), `D\\B$`)
	.replace(new RegExp(`\\$${uniqueId}\\$\\\\(?:\\\\)?\\$D\\$`, `g`), `_\\_D_S`)
	.replace(new RegExp(`\\$${uniqueId}\\$\\\\(?:\\\\)?\\$FMCL\\$`, `g`), `_\\_FMCL_`)
	.replace(new RegExp(`\\$${uniqueId}\\$\\\\(?:\\\\)?\\$G\\$`, `g`), `_\\_G_`)
	.replace(new RegExp(`\\$${uniqueId}\\$(\\d)\\$SUBSCRIPT\\$(\\w+)\\$(\\w+)\\$`, `g`), (_, seclevel, user, script) => `#${'nlmhf'[seclevel]}s.${user}.${script}`)
	.replace(new RegExp(`\\$${uniqueId}\\$DEBUG\\$`, `g`), `#D`)
	.replace(new RegExp(`\\$${uniqueId}\\$FMCL\\$`, `g`), `#FMCL`)
	.replace(new RegExp(`\\$${uniqueId}\\$GLOBAL\\$`, `g`), `#G`)
	.replace(new RegExp(`\\$${uniqueId}\\$DB\\$(\\w+)\\$`, `g`), `#db.$1`)
	.replace(new RegExp(`\\$${uniqueId}\\$SLASH_SLASH\\$`, `g`), `/\\/`)
	.replace(new RegExp(`\\$${uniqueId}\\$NOT_A_SUBSCRIPT\\$(#[\\w\\.]+)\\(\\$`, `g`), `$1\\(`)
	.replace(new RegExp(`\\$${uniqueId}\\$NOT_A_DB_CALL\\$(\\w+)\\$`, `g`), `#db.$1\\(`)
	.replace(new RegExp(`\\$${uniqueId}\\$NOT_A_DEBUG_CALL\\$`, `g`), `#D\\(`)
	.replace(new RegExp(`\\$${uniqueId}\\$NOT_FMCL\\$`, `g`), `#\\FMCL`)
	.replace(new RegExp(`\\$${uniqueId}\\$NOT_G\\$`, `g`), `#\\G`)
