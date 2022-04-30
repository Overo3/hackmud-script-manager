import babelGenerator from "@babel/generator"
import babelTraverse, { NodePath } from "@babel/traverse"
import t, { Expression, File, FunctionDeclaration, Program } from "@babel/types"
import { assert, countHackmudCharacters, LaxPartial, spliceString } from "@samual/lib"
import { tokenizer as tokenize, tokTypes as tokenTypes } from "acorn"
import * as terser from "terser"
import { getReferencePathsToGlobal, includesIllegalString, replaceUnsafeStrings } from "./shared"

const { default: generate } = babelGenerator as any as typeof import("@babel/generator")
const { default: traverse } = babelTraverse as any as typeof import("@babel/traverse")

type MinifyOptions = {
	/** 11 a-z 0-9 characters */
	uniqueID: string

	/** whether to mangle function and class names (defaults to `false`) */
	mangleNames: boolean

	/**
	 * when set to `true` forces use of quine cheats
	 *
	 * when set to `false` forces quine cheats not to be used
	 *
	 * when left unset or set to `undefined`, automatically uses or doesn't use quine cheats based on character count
	 */
	forceQuineCheats: boolean

	/** the comment inserted after the function signature */
	autocomplete: string
}

// TODO move autocomplete code outside this function
// TODO replace references to `arguments`

/**
 * @param file babel ast node representing a file containing transformed code
 * @param options {@link MinifyOptions details}
 */
export async function minify(file: File, {
	uniqueID = `00000000000`,
	mangleNames = false,
	forceQuineCheats,
	autocomplete
}: LaxPartial<MinifyOptions> = {}) {
	assert(/^\w{11}$/.exec(uniqueID))

	let program!: NodePath<Program>

	traverse(file, {
		Program(path) {
			program = path
			path.skip()
		}
	})

	if (program.scope.hasGlobal(`_START`)) {
		for (const referencePath of getReferencePathsToGlobal(`_START`, program))
			referencePath.replaceWith(t.identifier(`_ST`))
	}

	if (program.scope.hasGlobal(`_TIMEOUT`)) {
		for (const referencePath of getReferencePathsToGlobal(`_TIMEOUT`, program))
			referencePath.replaceWith(t.identifier(`_TO`))
	}

	// typescript does not like NodePath#get() and becomes slow so I have to dance around it
	const mainFunctionPath = program.get(`body.0` as string) as NodePath<FunctionDeclaration>

	for (const parameter of [ ...mainFunctionPath.node.params ].reverse()) {
		if (parameter.type == `Identifier`) {
			const binding = mainFunctionPath.scope.getBinding(parameter.name)!

			if (!binding.referenced) {
				mainFunctionPath.node.params.pop()

				continue
			}
		}

		break
	}

	for (const global in (program.scope as any).globals as Record<string, any>) {
		if (global == `arguments` || global.startsWith(`$${uniqueID}$`))
			continue

		const referencePaths = getReferencePathsToGlobal(global, program)

		if (5 + global.length + referencePaths.length >= global.length * referencePaths.length)
			continue

		for (const path of referencePaths)
			path.replaceWith(t.identifier(`_${uniqueID}_GLOBAL_${global}_`))

		mainFunctionPath.node.body.body.unshift(
			t.variableDeclaration(
				`let`,
				[
					t.variableDeclarator(
						t.identifier(`_${uniqueID}_GLOBAL_${global}_`),
						t.identifier(global)
					)
				]
			)
		)
	}

	const hashGReferencePaths = getReferencePathsToGlobal(`$${uniqueID}$GLOBAL$`, program)

	if (hashGReferencePaths.length > 3) {
		for (const path of hashGReferencePaths)
			path.replaceWith(t.identifier(`_${uniqueID}_G_`))

		mainFunctionPath.node.body.body.unshift(
			t.variableDeclaration(
				`let`,
				[
					t.variableDeclarator(
						t.identifier(`_${uniqueID}_G_`),
						t.identifier(`$${uniqueID}$GLOBAL$`)
					)
				]
			)
		)
	}

	const jsonValues: any[] = []
	// this needs `as boolean` because typescript is dumb
	let undefinedIsReferenced = false as boolean
	let scriptBeforeJSONValueReplacement

	if (forceQuineCheats != true) {
		const fileBeforeJSONValueReplacement = t.cloneNode(file)

		traverse(fileBeforeJSONValueReplacement, {
			MemberExpression({ node: memberExpression }) {
				if (memberExpression.computed)
					return

				assert(memberExpression.property.type == `Identifier`)

				if (memberExpression.property.name == `prototype`) {
					memberExpression.computed = true
					memberExpression.property = t.identifier(`_${uniqueID}_PROTOTYPE_PROPERTY_`)
				} else if (memberExpression.property.name == `__proto__`) {
					memberExpression.computed = true
					memberExpression.property = t.identifier(`_${uniqueID}_PROTO_PROPERTY_`)
				} else if (includesIllegalString(memberExpression.property.name)) {
					memberExpression.computed = true

					memberExpression.property = t.stringLiteral(
						replaceUnsafeStrings(uniqueID, memberExpression.property.name)
					)
				}
			},

			ObjectProperty({ node: objectProperty }) {
				if (objectProperty.key.type == `Identifier` && includesIllegalString(objectProperty.key.name)) {
					objectProperty.key = t.stringLiteral(replaceUnsafeStrings(uniqueID, objectProperty.key.name))
					objectProperty.shorthand = false
				}
			},

			StringLiteral({ node }) {
				node.value = replaceUnsafeStrings(uniqueID, node.value)
			},

			TemplateLiteral({ node }) {
				for (const templateElement of node.quasis) {
					if (templateElement.value.cooked) {
						templateElement.value.cooked = replaceUnsafeStrings(uniqueID, templateElement.value.cooked)

						templateElement.value.raw = templateElement.value.cooked
							.replace(/\\/g, `\\\\`)
							.replace(/`/g, `\\\``)
							// eslint-disable-next-line unicorn/better-regex, optimize-regex/optimize-regex
							.replace(/\$\{/g, `$\\{`)
					} else
						templateElement.value.raw = replaceUnsafeStrings(uniqueID, templateElement.value.raw)
				}
			},

			RegExpLiteral(path) {
				path.node.pattern = replaceUnsafeStrings(uniqueID, path.node.pattern)
				delete path.node.extra
			}
		})

		scriptBeforeJSONValueReplacement = (await terser.minify(generate(fileBeforeJSONValueReplacement!).code, {
			ecma: 2015,
			compress: {
				passes: Infinity,
				unsafe: true,
				unsafe_arrows: true,
				unsafe_comps: true,
				unsafe_symbols: true,
				unsafe_methods: true,
				unsafe_proto: true,
				unsafe_regexp: true,
				unsafe_undefined: true,
				sequences: false
			},
			format: { semicolons: false },
			keep_classnames: !mangleNames,
			keep_fnames: !mangleNames
		})).code!
			.replace(new RegExp(`_${uniqueID}_PROTOTYPE_PROPERTY_`, `g`), `"prototype"`)
			.replace(new RegExp(`_${uniqueID}_PROTO_PROPERTY_`, `g`), `"__proto__"`)

		if (autocomplete)
			scriptBeforeJSONValueReplacement = spliceString(scriptBeforeJSONValueReplacement, `//${autocomplete}\n`, getFunctionBodyStart(scriptBeforeJSONValueReplacement) + 1)

		if (forceQuineCheats == false)
			return scriptBeforeJSONValueReplacement
	}

	let comment: string | undefined
	let hasComment = false
	let code

	{
		const promises: Promise<any>[] = []

		traverse(file, {
			FunctionDeclaration(path) {
				path.traverse({
					Function(path) {
						if (path.parent.type != `CallExpression` && path.parentKey != `callee`)
							path.skip()
					},

					Loop(path) {
						path.skip()
					},

					ObjectExpression(path) {
						const o: Record<string, unknown> = {}

						if (parseObjectExpression(path.node, o))
							path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValues.push(o) - 1}_`))
					},

					ArrayExpression(path) {
						const o: unknown[] = []

						if (parseArrayExpression(path.node, o))
							path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValues.push(o) - 1}_`))
					}
				})

				path.traverse({
					TemplateLiteral(path) {
						if (path.parent.type == `TaggedTemplateExpression`)
							return

						const templateLiteral = path.node
						let replacement: babel.Node = t.stringLiteral(templateLiteral.quasis[0]!.value.cooked!)

						for (let index = 0; index < templateLiteral.expressions.length; index++) {
							const expression = templateLiteral.expressions[index] as Expression
							const templateElement = templateLiteral.quasis[index + 1]!

							replacement = t.binaryExpression(
								`+`,
								replacement,
								expression
							)

							if (!templateElement.value.cooked)
								continue

							replacement = t.binaryExpression(
								`+`,
								replacement,
								t.stringLiteral(templateElement.value.cooked!)
							)
						}

						path.replaceWith(replacement)
					},

					MemberExpression({ node: memberExpression }) {
						if (memberExpression.computed)
							return

						assert(memberExpression.property.type == `Identifier`)

						if (memberExpression.property.name.length < 3)
							return

						memberExpression.computed = true
						memberExpression.property = t.stringLiteral(memberExpression.property.name)
					},

					UnaryExpression(path) {
						if (path.node.operator == `void`) {
							if (path.node.argument.type == `NumericLiteral` && !path.node.argument.value) {
								path.replaceWith(t.identifier(`_${uniqueID}_UNDEFINED_`))
								undefinedIsReferenced = true
							}
						} else if (path.node.operator == `-` && path.node.argument.type == `NumericLiteral`) {
							const value = -path.node.argument.value

							promises.push((async () => {
								if ((await minifyNumber(value)).length <= 3)
									return

								if (path.parentKey == `key` && path.parent.type == `ObjectProperty`)
									path.parent.computed = true

								let jsonValueIndex = jsonValues.indexOf(value)

								if (jsonValueIndex == -1)
									jsonValueIndex += jsonValues.push(value)

								path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValueIndex}_`))
							})())

							path.skip()
						}
					},

					NullLiteral(path) {
						/* eslint-disable unicorn/no-null */
						let jsonValueIndex = jsonValues.indexOf(null)

						if (jsonValueIndex == -1)
							jsonValueIndex += jsonValues.push(null)

						path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValueIndex}_`))
						/* eslint-enable unicorn/no-null */
					},

					NumericLiteral(path) {
						promises.push((async () => {
							if ((await minifyNumber(path.node.value)).length <= 3)
								return

							if (path.parentKey == `key` && path.parent.type == `ObjectProperty`)
								path.parent.computed = true

							let jsonValueIndex = jsonValues.indexOf(path.node.value)

							if (jsonValueIndex == -1)
								jsonValueIndex += jsonValues.push(path.node.value)

							path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValueIndex}_`))
						})())
					},

					StringLiteral(path) {
						path.node.value = replaceUnsafeStrings(uniqueID, path.node.value)

						// eslint-disable-next-line @typescript-eslint/no-base-to-string -- the `NodePath`'s `.toString()` method compiles and returns the contained `Node`
						if (JSON.stringify(path.node.value).includes(`\\u00`) || path.toString().length < 4)
							return

						if (path.parentKey == `key` && path.parent.type == `ObjectProperty`)
							path.parent.computed = true

						let jsonValueIndex = jsonValues.indexOf(path.node.value)

						if (jsonValueIndex == -1)
							jsonValueIndex += jsonValues.push(path.node.value)

						path.replaceWith(t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValueIndex}_`))
					},

					ObjectProperty({ node }) {
						if (node.computed || node.key.type != `Identifier` || node.key.name.length < 4)
							return

						let jsonValueIndex = jsonValues.indexOf(node.key.name)

						if (jsonValueIndex == -1)
							jsonValueIndex += jsonValues.push(node.key.name)

						node.computed = true
						node.key = t.identifier(`_${uniqueID}_JSON_VALUE_${jsonValueIndex}_`)
					},

					RegExpLiteral(path) {
						path.node.pattern = replaceUnsafeStrings(uniqueID, path.node.pattern)
						delete path.node.extra
					}
				})

				path.skip()
			}
		})

		await Promise.all(promises)

		const functionDeclaration = file.program.body[0]!

		assert(functionDeclaration.type == `FunctionDeclaration`)

		if (jsonValues.length) {
			hasComment = true

			if (jsonValues.length == 1) {
				if (typeof jsonValues[0] == `string` && !jsonValues[0].includes(`\n`) && !jsonValues[0].includes(`\t`)) {
					const variableDeclaration = t.variableDeclaration(
						`let`,
						[
							t.variableDeclarator(
								t.identifier(`_${uniqueID}_JSON_VALUE_0_`),
								t.memberExpression(
									t.taggedTemplateExpression(
										t.memberExpression(
											t.callExpression(t.identifier(`$${uniqueID}$SUBSCRIPT$scripts$quine$`), []),
											t.identifier(`split`)
										),
										t.templateLiteral([ t.templateElement({ raw: `\t`, cooked: `\t` }, true) ], [])
									),
									t.identifier(`$${uniqueID}$SPLIT_INDEX$`),
									true
								)
							)
						]
					)

					if (undefinedIsReferenced)
						variableDeclaration.declarations.push(t.variableDeclarator(t.identifier(`_${uniqueID}_UNDEFINED_`)))

					functionDeclaration.body.body.unshift(variableDeclaration)
					comment = jsonValues[0]
				} else {
					const variableDeclaration = t.variableDeclaration(
						`let`,
						[
							t.variableDeclarator(
								t.identifier(`_${uniqueID}_JSON_VALUE_0_`),
								t.callExpression(
									t.memberExpression(
										t.identifier(`JSON`),
										t.identifier(`parse`)
									),
									[
										t.memberExpression(
											t.taggedTemplateExpression(
												t.memberExpression(
													t.callExpression(t.identifier(`$${uniqueID}$SUBSCRIPT$scripts$quine$`), []),
													t.identifier(`split`)
												),
												t.templateLiteral([ t.templateElement({ raw: `\t`, cooked: `\t` }, true) ], [])
											),
											t.identifier(`$${uniqueID}$SPLIT_INDEX$`),
											true
										)
									]
								)
							)
						]
					)

					if (undefinedIsReferenced)
						variableDeclaration.declarations.push(t.variableDeclarator(t.identifier(`_${uniqueID}_UNDEFINED_`)))

					functionDeclaration.body.body.unshift(variableDeclaration)
					comment = JSON.stringify(jsonValues[0])
				}
			} else {
				const variableDeclaration = t.variableDeclaration(
					`let`,
					[
						t.variableDeclarator(
							t.arrayPattern(jsonValues.map((_, index) => t.identifier(`_${uniqueID}_JSON_VALUE_${index}_`))),
							t.callExpression(
								t.memberExpression(
									t.identifier(`JSON`),
									t.identifier(`parse`)
								),
								[
									t.memberExpression(
										t.taggedTemplateExpression(
											t.memberExpression(
												t.callExpression(t.identifier(`$${uniqueID}$SUBSCRIPT$scripts$quine$`), []),
												t.identifier(`split`)
											),
											t.templateLiteral([ t.templateElement({ raw: `\t`, cooked: `\t` }, true) ], [])
										),
										t.identifier(`$${uniqueID}$SPLIT_INDEX$`),
										true
									)
								]
							)
						)
					]
				)

				if (undefinedIsReferenced)
					variableDeclaration.declarations.push(t.variableDeclarator(t.identifier(`_${uniqueID}_UNDEFINED_`)))

				functionDeclaration.body.body.unshift(variableDeclaration)
				comment = JSON.stringify(jsonValues)
			}
		} else if (undefinedIsReferenced) {
			functionDeclaration.body.body.unshift(
				t.variableDeclaration(
					`let`,
					[ t.variableDeclarator(t.identifier(`_${uniqueID}_UNDEFINED_`)) ]
				)
			)
		}

		code = generate(file!).code
	}

	code = (await terser.minify(code, {
		ecma: 2015,
		compress: {
			passes: Infinity,
			unsafe: true,
			unsafe_arrows: true,
			unsafe_comps: true,
			unsafe_symbols: true,
			unsafe_methods: true,
			unsafe_proto: true,
			unsafe_regexp: true,
			unsafe_undefined: true,
			sequences: false
		},
		format: { semicolons: false },
		keep_classnames: !mangleNames,
		keep_fnames: !mangleNames
	})).code || ``

	// this step affects the character count and can't happen after the count comparison
	if (comment != undefined) {
		code = spliceString(code, `${autocomplete ? `//${autocomplete}\n` : ``}\n//\t${comment}\t\n`, getFunctionBodyStart(code) + 1)
		code = code.replace(`$${uniqueID}$SPLIT_INDEX$`, await minifyNumber(code.split(`\t`).findIndex(part => part == comment)))
	}

	if (forceQuineCheats == true)
		return code

	assert(scriptBeforeJSONValueReplacement)

	// if the script has a comment, it's gonna contain `SC$scripts$quine()`
	// which is gonna compile to `#fs.scripts.quine()` which contains
	// an extra character so we have to account for that
	if (countHackmudCharacters(scriptBeforeJSONValueReplacement) <= (countHackmudCharacters(code) + Number(hasComment)))
		return scriptBeforeJSONValueReplacement

	return code
}

export default minify

function parseObjectExpression(node: babel.types.ObjectExpression, o: Record<string, unknown>) {
	if (!node.properties.length)
		return false

	for (const property of node.properties) {
		if (property.type != `ObjectProperty` || property.computed)
			return false

		assert(property.key.type == `Identifier` || property.key.type == `NumericLiteral` || property.key.type == `StringLiteral`)

		if (property.value.type == `ArrayExpression`) {
			const childArray: unknown[] = []

			if (parseArrayExpression(property.value, childArray))
				o[property.key.type == `Identifier` ? property.key.name : property.key.value] = childArray
			else
				return false
		} else if (property.value.type == `ObjectExpression`) {
			const childObject: Record<string, unknown> = {}

			if (parseObjectExpression(property.value, childObject))
				o[property.key.type == `Identifier` ? property.key.name : property.key.value] = childObject
			else
				return false
		} else if (property.value.type == `NullLiteral`)
			// eslint-disable-next-line unicorn/no-null
			o[property.key.type == `Identifier` ? property.key.name : property.key.value] = null
		else if (property.value.type == `BooleanLiteral` || property.value.type == `NumericLiteral` || property.value.type == `StringLiteral`)
			o[property.key.type == `Identifier` ? property.key.name : property.key.value] = property.value.value
		else if (property.value.type == `TemplateLiteral` && !property.value.expressions.length)
			o[property.key.type == `Identifier` ? property.key.name : property.key.value] = property.value.quasis[0]!.value.cooked
		else
			return false
	}

	return true
}

function parseArrayExpression(node: babel.types.ArrayExpression, o: unknown[]) {
	if (!node.elements.length)
		return false

	for (const element of node.elements) {
		if (!element)
			return false

		if (element.type == `ArrayExpression`) {
			const childArray: unknown[] = []

			if (parseArrayExpression(element, childArray))
				childArray.push(childArray)
			else
				return false
		} else if (element.type == `ObjectExpression`) {
			const childObject: Record<string, unknown> = {}

			if (parseObjectExpression(element, childObject))
				o.push(childObject)
			else
				return false
		} else if (element.type == `NullLiteral`)
			// eslint-disable-next-line unicorn/no-null
			o.push(null)
		else if (element.type == `BooleanLiteral` || element.type == `NumericLiteral` || element.type == `StringLiteral`)
			o.push(element.value)
		else if (element.type == `TemplateLiteral` && !element.expressions.length)
			o.push(element.quasis[0]!.value.cooked)
		else
			return false
	}

	return true
}

async function minifyNumber(number: number) {
	return /\$\((?<number>.+)\)/.exec(((await terser.minify(`$(${number})`, { ecma: 2015 })).code!))!.groups!.number!
}

function getFunctionBodyStart(code: string) {
	const tokens = tokenize(code, { ecmaVersion: 2015 })

	tokens.getToken() // function
	tokens.getToken() // name
	tokens.getToken() // (

	let nests = 1

	while (nests) {
		const token = tokens.getToken()

		if (token.type == tokenTypes.parenL)
			nests++
		else if (token.type == tokenTypes.parenR)
			nests--
	}

	return tokens.getToken().start // {
}
