import { execSync } from 'child_process'
import { fetch } from 'cross-fetch'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import path, { join } from 'path'
import { compare, parse } from 'semver'
import { exec } from './exec'
import { BUBLIC_ROOT } from './file'
import { nicelog } from './nicelog'
import fs from 'fs';

const copyRecursiveSync = (src: string, dest: string) => {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats && stats.isDirectory();
    if (isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach(childItemName => {
            copyRecursiveSync(path.join(src, childItemName),
                              path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
};


export type PackageDetails = {
	name: string
	dir: string
	localDeps: string[]
	version: string
}

function getPackageDetails(dir: string): PackageDetails | null {
	const packageJsonPath = path.join(dir, 'package.json')
	if (!existsSync(packageJsonPath)) {
		return null
	}
	const packageJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
	if (packageJson.private) {
		return null
	}
	return {
		name: packageJson.name,
		dir,
		version: packageJson.version,
		localDeps: Object.keys(packageJson.dependencies ?? {}).filter((dep) =>
			dep.startsWith('@tldraw')
		),
	}
}

export function getAllPackageDetails(): Record<string, PackageDetails> {
	const dirs = readdirSync(join(BUBLIC_ROOT, 'packages'))
	const results = dirs
		.map((dir) => getPackageDetails(path.join(BUBLIC_ROOT, 'packages', dir)))
		.filter((x): x is PackageDetails => Boolean(x))

	return Object.fromEntries(results.map((result) => [result.name, result]))
}

export function setAllVersions(version: string) {
	const packages = getAllPackageDetails()
	for (const packageDetails of Object.values(packages)) {
		const manifest = JSON.parse(readFileSync(path.join(packageDetails.dir, 'package.json'), 'utf8'))
		manifest.version = version
		writeFileSync(
			path.join(packageDetails.dir, 'package.json'),
			JSON.stringify(manifest, null, '\t') + '\n'
		)
		if (manifest.name === '@tldraw/editor') {
			const versionFileContents = `export const version = '${version}'\n`
			writeFileSync(path.join(packageDetails.dir, 'src', 'version.ts'), versionFileContents)
		}
		if (manifest.name === '@tldraw/tldraw') {
			const versionFileContents = `export const version = '${version}'\n`
			writeFileSync(
				path.join(packageDetails.dir, 'src', 'lib', 'ui', 'version.ts'),
				versionFileContents
			)
		}
	}

	const lernaJson = JSON.parse(readFileSync('lerna.json', 'utf8'))
	lernaJson.version = version
	writeFileSync('lerna.json', JSON.stringify(lernaJson, null, '\t') + '\n')

	execSync('yarn')
}

export function getLatestVersion() {
	const packages = getAllPackageDetails()

	const allVersions = Object.values(packages).map((p) => parse(p.version)!)
	allVersions.sort(compare)

	const latestVersion = allVersions[allVersions.length - 1]

	if (!latestVersion) {
		throw new Error('Could not find latest version')
	}

	return latestVersion
}

function topologicalSortPackages(packages: Record<string, PackageDetails>) {
	const sorted: PackageDetails[] = []
	const visited = new Set<string>()

	function visit(packageName: string, path: string[]) {
		if (visited.has(packageName)) {
			return
		}
		visited.add(packageName)
		const packageDetails = packages[packageName]
		if (!packageDetails) {
			throw new Error(`Could not find package ${packageName}. path: ${path.join(' -> ')}`)
		}
		packageDetails.localDeps.forEach((dep) => visit(dep, [...path, dep]))
		sorted.push(packageDetails)
	}

	Object.keys(packages).forEach((packageName) => visit(packageName, [packageName]))

	return sorted
}

export async function publish() {
	// const npmToken = process.env.NPM_TOKEN
	// if (!npmToken) {
	// 	throw new Error('NPM_TOKEN not set')
	// }
	const npmToken = 'sr8yMiDOGOGgbLKyquniig=='

	execSync(`yarn config set npmAuthToken ${npmToken}`, { stdio: 'inherit' })
	execSync(`yarn config set npmRegistryServer http://127.0.0.1:4873`, { stdio: 'inherit' })

	const packages = getAllPackageDetails()

	const publishOrder = topologicalSortPackages(packages)

	for (const packageDetails of publishOrder) {
		const prereleaseTag = parse(packageDetails.version)?.prerelease[0] ?? 'latest'
		nicelog(
			`Publishing ${packageDetails.name} with version ${packageDetails.version} under tag @${prereleaseTag}`
		)

		await retry(
			async () => {
				let output = ''
				try {
					await exec(
						`yarn`,
						[
							'npm',
							'publish',
							'--tag',
							String(prereleaseTag),
							'--tolerate-republish',
							'--access',
							'public',
						],
						{
							pwd: packageDetails.dir,
							processStdoutLine: (line) => {
								output += line + '\n'
								nicelog(line)
							},
							processStderrLine: (line) => {
								output += line + '\n'
								nicelog(line)
							},
						}
					)
				} catch (e) {
					if (output.includes('You cannot publish over the previously published versions')) {
						// --tolerate-republish seems to not work for canary versions??? so let's just ignore this error
						return
					}
					throw e
				}
			},
			{
				delay: 10_000,
				numAttempts: 5,
			}
		)

		await retry(
			async ({ attempt, total }) => {
				nicelog('Waiting for package to be published... attempt', attempt, 'of', total)
				// fetch the new package directly from the npm registry
				const newVersion = packageDetails.version
				const unscopedName = packageDetails.name.replace('@tldraw/', '')

				const url = `http://127.0.0.1:4873/@tldraw/${unscopedName}/-/${unscopedName}-${newVersion}.tgz`
				nicelog('looking for package at url: ', url)
				const res = await fetch(url, {
					method: 'HEAD',
				})
				if (res.status >= 400) {
					throw new Error(`Package not found: ${res.status}`)
				}
			},
			{
				delay: 3000,
				numAttempts: 10,
			}
		)

		const newVersion = packageDetails.version
		const unscopedName = packageDetails.name.replace('@tldraw/', '')


		// Remove the tldraw-assets repo
		try {
			await exec(`rm`, ['-rf', 'tldraw-assets'])
		} catch {
			// ignore
		}



		// Remove 
		try {
			await exec(`rm`, ['-rf',`./package`])
		} catch {
			// ignore
		}

		// Once we've made sure it's avialble on the registry, we're going to download
		// the tarball and upload it to our github repo
		// 	curl http://127.0.0.1:4873/@tldraw/tldraw/-/tldraw-2.0.0-canary.fe9e0d5de535.tgz > out.tgz
		await exec(`curl`, [
			'-O',
			`http://127.0.0.1:4873/@tldraw/${unscopedName}/-/${unscopedName}-${newVersion}.tgz`,
		])

		// Clone the tldraw-assets repo
		await exec(`git`, ['clone', 'https://github.com/superwall-me/tldraw-assets.git'])

		// Extract the tarball into the tldraw-assets repo
		await exec(`tar`, ['-xzf', `${unscopedName}-${newVersion}.tgz`, '-C', './'])

		// Move `/package` into `/packages/${unscopedName}`
		// Using nodejs copy all files from `/package` into
		// `/packages/${unscopedName}`
		// await exec(`cp`, ['-r', './package/*', `tldraw-assets/`] )
		copyRecursiveSync('./package/', `./tldraw-assets`)

		// Checkout the branch
		await exec(`git`, ['checkout', '-b', `${unscopedName}-${newVersion}`], { pwd: './tldraw-assets' })

		// Add everything 
		await exec(`git`, ['add', '.'],{ pwd: './tldraw-assets' })

		// Commit
		await exec(`git`, ['commit', '-m', `Publish ${unscopedName}@${newVersion}`],{ pwd: './tldraw-assets' })

		// Push
		await exec(`git`, ['push', '-f', '-u', 'origin', `${unscopedName}-${newVersion}`],{ pwd: './tldraw-assets' })

		// Remove the tarball
		try {
			await exec(`rm`, ['-rf',`${unscopedName}-${newVersion}.tgz`])
		} catch {
			// ignore
		}

		// Remove the tldraw-assets repo
		try {
			await exec(`rm`, ['-rf', 'tldraw-assets'])
		} catch {
			// ignore
		}

		// Remove 
		try {
			await exec(`rm`, ['-rf',`./package`])
		} catch {
			// ignore
		}
		
	}
}

function retry(
	fn: (args: { attempt: number; remaining: number; total: number }) => Promise<void>,
	opts: {
		numAttempts: number
		delay: number
	}
): Promise<void> {
	return new Promise((resolve, reject) => {
		let attempts = 0
		function attempt() {
			fn({ attempt: attempts, remaining: opts.numAttempts - attempts, total: opts.numAttempts })
				.then(resolve)
				.catch((err) => {
					attempts++
					if (attempts >= opts.numAttempts) {
						reject(err)
					} else {
						setTimeout(attempt, opts.delay)
					}
				})
		}
		attempt()
	})
}
