import tilebelt from '@mapbox/tilebelt'

export default class OGCFeatureCollection {
    constructor(sourceId, map, collectionOptions, geojsonSourceOptions) {
        if (!sourceId || !map || !collectionOptions) throw new Error('Source id, map and collectionOptions must be supplied as the first three arguments.')
        if (!collectionOptions.url) throw new Error('A url must be supplied as part of the collectionOptions object.')
        if (!collectionOptions.collectionId) throw new Error('A collectionId must be supplied as part of the collectionOptions object.')

        this.sourceId = sourceId
        this._map = map

        this._tileIndices = new Map()
        this._featureIndices = new Map()
        this._featureCollections = new Map()

        this._collectionServiceOptions = Object.assign({
            limit: 5000,
            useStaticZoomLevel: false,
            minZoom: collectionOptions.useStaticZoomLevel ? 7 : 2
        }, collectionOptions)

        this.serviceMetadata = null
        this._maxExtent = [-Infinity, Infinity, -Infinity, Infinity]

        const gjOptions = !geojsonSourceOptions ? {} : geojsonSourceOptions
        this._map.addSource(sourceId, Object.assign(gjOptions, {
            type: 'geojson',
            data: this._getBlankFc()
        }))

        this.enableRequests()
        this._clearAndRefreshTiles()
    }

    destroySource() {
        this.disableRequests()
        this._map.removeSource(this.sourceId)
    }

    _getBlankFc() {
        return {
            type: 'FeatureCollection',
            features: []
        }
    }

    disableRequests() {
        this._map.off('moveend', this._boundEvent)
    }

    enableRequests() {
        this._boundEvent = this._findAndMapData.bind(this)
        this._map.on('moveend', this._boundEvent)
    }

    _clearAndRefreshTiles() {
        this._tileIndices = new Map()
        this._featureIndices = new Map()
        this._featureCollections = new Map()
        this._findAndMapData()
    }

    _createOrGetTileIndex(zoomLevel) {
        const existingZoomIndex = this._tileIndices.get(zoomLevel)
        if (existingZoomIndex) return existingZoomIndex
        const newIndex = new Map()
        this._tileIndices.set(zoomLevel, newIndex)
        return newIndex
    }

    _createOrGetFeatureCollection(zoomLevel) {
        const existingZoomIndex = this._featureCollections.get(zoomLevel)
        if (existingZoomIndex) return existingZoomIndex
        const fc = this._getBlankFc()
        this._featureCollections.set(zoomLevel, fc)
        return fc
    }

    _createOrGetFeatureIdIndex(zoomLevel) {
        const existingFeatureIdIndex = this._featureIndices.get(zoomLevel)
        if (existingFeatureIdIndex) return existingFeatureIdIndex
        const newFeatureIdIndex = new Map()
        this._featureIndices.set(zoomLevel, newFeatureIdIndex)
        return newFeatureIdIndex
    }

    async _findAndMapData() {
        const z = this._map.getZoom()

        if (z < this._collectionServiceOptions.minZoom) {
            return
        }
        const bounds = this._map.getBounds().toArray()
        const primaryTile = tilebelt.bboxToTile([bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]])

        // If we're not using a static zoom level we'll round to the nearest even zoom level
        // This means we don't need to request new data for every zoom level allowing us to reuse the previous levels data
        const zoomLevel = this._collectionServiceOptions.useStaticZoomLevel ? this._collectionServiceOptions.minZoom : 2 * Math.floor(z / 2)
        const zoomLevelIndex = this._createOrGetTileIndex(zoomLevel)
        const featureIdIndex = this._createOrGetFeatureIdIndex(zoomLevel)
        const fc = this._createOrGetFeatureCollection(zoomLevel)

        const tilesToRequest = []

        if (primaryTile[2] < zoomLevel) {
            let candidateTiles = tilebelt.getChildren(primaryTile)
            let minZoomOfCandidates = candidateTiles[0][2]
            while (minZoomOfCandidates < zoomLevel) {
                const newCandidateTiles = []
                candidateTiles.forEach(t => newCandidateTiles.push(...tilebelt.getChildren(t)))
                candidateTiles = newCandidateTiles
                minZoomOfCandidates = candidateTiles[0][2]
            }

            for (let index = 0; index < candidateTiles.length; index++) {
                if (this._doesTileOverlapBbox(candidateTiles[index], bounds)) {
                    tilesToRequest.push(candidateTiles[index])
                }
            }
        } else {
            tilesToRequest.push(primaryTile)
        }

        for (let index = 0; index < tilesToRequest.length; index++) {
            const quadKey = tilebelt.tileToQuadkey(tilesToRequest[index])
            if (zoomLevelIndex.has(quadKey)) {
                tilesToRequest.splice(index, 1)
                index--
            } else zoomLevelIndex.set(quadKey, true)
        }

        if (tilesToRequest.length === 0) {
            this._updateFcOnMap(fc)
            return
        }

        // This tolerance will be used to inform the quantization/simplification of features
        const mapWidth = Math.abs(bounds[1][0] - bounds[0][0])
        const tolerance = (mapWidth / this._map.getCanvas().width) * this._collectionServiceOptions.simplifyFactor
        await this._loadTiles(tilesToRequest, tolerance, featureIdIndex, fc)
        this._updateFcOnMap(fc)
    }

    async _loadTiles(tilesToRequest, tolerance, featureIdIndex, fc) {
        return new Promise((resolve) => {
            const promises = tilesToRequest.map(t => this._getTile(t, tolerance))
            Promise.all(promises).then((featureCollections) => {
                featureCollections.forEach((tileFc) => {
                    if (tileFc) this._iterateItems(tileFc, featureIdIndex, fc)
                })
                resolve()
            })
        })
    }

    _iterateItems(tileFc, featureIdIndex, fc) {
        if (tileFc.features != null){
            tileFc.features.forEach((feature) => {
                if (!featureIdIndex.has(feature.id)) {
                    fc.features.push(feature)
                    featureIdIndex.set(feature.id)
                }
            })
        }
    }

    _getTile(tile) {
        const tileBounds = tilebelt.tileToBBOX(tile)

        let urlParams = `limit=${this._collectionServiceOptions.limit}&bbox=${tileBounds[0]},${tileBounds[1]},${tileBounds[2]},${tileBounds[3]}`

        let blacklist_parameters = ['limit','url','useStaticZoomLevel','collectionId','minZoom']

        for(let option in this._collectionServiceOptions){
            if (! blacklist_parameters.includes(option)){
                urlParams += `&${option}=${this._collectionServiceOptions[option]}`
            }
        }

        return new Promise((resolve) => {
            fetch(`${`${this._collectionServiceOptions.url}/collections/${this._collectionServiceOptions.collectionId}/items?${urlParams}`}`, this._collectionServiceOptions.fetchOptions)
                .then(response => (response.json()))
                .then((data) => {
                    resolve(data)
                })
        })
    }

    _updateFcOnMap(fc) {
        this._map.getSource(this.sourceId).setData(fc)
    }

    _doesTileOverlapBbox(tile, bbox) {
        const tileBounds = tile.length === 4 ? tile : tilebelt.tileToBBOX(tile)
        if (tileBounds[2] < bbox[0][0]) return false
        if (tileBounds[0] > bbox[1][0]) return false
        if (tileBounds[3] < bbox[0][1]) return false
        if (tileBounds[1] > bbox[1][1]) return false
        return true
    }
}