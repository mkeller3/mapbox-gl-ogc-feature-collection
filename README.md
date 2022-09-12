
# mapbox-gl-ogc-feature-collection

A small package for requesting geojson from an OGC Feature API endpoint to serve tiles in MapBox/MapLibre.

Built with inspiration from [mapbox-gl-arcgis-featureserver](https://github.com/rowanwins/mapbox-gl-arcgis-featureserver).

### Basic Usage
````javascript
import OGCFeatureCollection from 'mapbox-gl-ogc-feature-collection'

map.on('load', () => {
    const fsSourceId = 'featureserver-src'

    new OGCFeatureCollection(fsSourceId, map, {
        url: 'https://demo.pygeoapi.io/covid-19',
        collectionId: 'cases_country',
        limit: 10000
    })

    map.addLayer({
        'id': 'fill-lyr',
        'source': fsSourceId,
        'type': 'circle',
        'paint': {
            'circle-color': '#B42222'
        }
    })
})
````