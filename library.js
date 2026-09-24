// The module library: a folder tree read from an index.json written by tools/index-mods.py.

export class Library {
	// onPick(url, name) is called when a track is chosen.
	constructor(treeEl, filterEl, onPick) {
		this.treeEl = treeEl
		this.filterEl = filterEl
		this.onPick = onPick
		this.tree = null
		this.base = ''
		this.current = null	// url of the track playing
		filterEl.addEventListener('input', () => this.render())
	}

	async load(indexUrl) {
		const response = await fetch(indexUrl, { cache: 'no-store' })
		if (!response.ok) throw new Error(`library index ${indexUrl}: HTTP ${response.status}`)
		this.tree = await response.json()
		this.base = new URL(indexUrl, location.href).href
		this.render()
		return count(this.tree)
	}

	setCurrent(url) {
		this.current = url
		for (const el of this.treeEl.querySelectorAll('.track')) {
			el.classList.toggle('playing', el.dataset.url === url)
		}
	}

	// The track after the current one, in the order shown (respecting the filter).
	next() {
		const tracks = [...this.treeEl.querySelectorAll('.track')]
		if (!tracks.length) return
		const i = tracks.findIndex(el => el.dataset.url === this.current)
		const el = tracks[(i + 1) % tracks.length]
		this.onPick(el.dataset.url, el.textContent)
	}

	render() {
		if (!this.tree) return
		const filter = this.filterEl.value.trim().toLowerCase()
		this.treeEl.replaceChildren(...this.renderFolder(this.tree, '', filter))
		this.setCurrent(this.current)
	}

	// Elements for a folder's contents; folders open when a filter is active.
	renderFolder(folder, path, filter) {
		const out = []
		for (const sub of folder.dirs) {
			const subPath = `${path}${sub.name}/`
			const children = this.renderFolder(sub, subPath, filter)
			if (!children.length) continue
			const details = document.createElement('details')
			details.open = filter !== ''
			const summary = document.createElement('summary')
			summary.textContent = `${sub.name} (${count(sub)})`
			details.append(summary, ...children)
			out.push(details)
		}
		for (const file of folder.files) {
			if (filter && !`${path}${file.name}`.toLowerCase().includes(filter)) continue
			const button = document.createElement('button')
			button.className = 'track'
			button.textContent = file.name
			button.dataset.url = new URL(file.url, this.base).href
			button.addEventListener('click', () => this.onPick(button.dataset.url, file.name))
			out.push(button)
		}
		return out
	}
}

function count(folder) {
	return folder.files.length + folder.dirs.reduce((n, d) => n + count(d), 0)
}
