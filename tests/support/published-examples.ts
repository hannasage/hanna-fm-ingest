/**
 * Answers shaped like the example JSON on the official MusicBrainz search page
 * (https://musicbrainz.org/doc/MusicBrainz_API/Search), for the recording, release-group and artist searches.
 * Copied from that page, not typed from memory. The lists are cut short: the artist list keeps its first
 * three hits, and the recording keeps its first release. Every key and value kept is the page's own.
 *
 * Ticket 7 checks the command against a live MusicBrainz response. Until then these are the best
 * statement of what MusicBrainz sends, and the only one that does not come from this repository.
 */

export const publishedArtistSearch = {
  "created": "2017-03-12T16:54:57.165Z",
  "count": 11,
  "offset": 0,
  "artists": [
    {
      "id": "e56fd97e-c18f-4e5e-9b4d-f9fc21b4973f",
      "type": "Group",
      "score": "100",
      "name": "Fred",
      "sort-name": "Fred",
      "country": "US",
      "area": {
        "id": "489ce91b-6658-3307-9877-795b68554c98",
        "name": "United States",
        "sort-name": "United States"
      },
      "begin-area": {
        "id": "489ce91b-6658-3307-9877-795b68554c98",
        "name": "United States",
        "sort-name": "United States"
      },
      "disambiguation": "US progressive rock band",
      "life-span": {
        "begin": "1969",
        "end": "1974",
        "ended": true
      }
    },
    {
      "id": "4a024fd4-305e-4fea-9d3f-4ec858766e6e",
      "type": "Group",
      "score": "100",
      "name": "Fred",
      "sort-name": "Fred",
      "country": "US",
      "area": {
        "id": "489ce91b-6658-3307-9877-795b68554c98",
        "name": "United States",
        "sort-name": "United States"
      },
      "disambiguation": "US comic barbershop quartet",
      "life-span": {
        "ended": null
      }
    },
    {
      "id": "1065e6e0-b6b3-4224-9121-4502e52b9f9e",
      "type": "Group",
      "score": "61",
      "name": "A Halo Called Fred",
      "sort-name": "A Halo Called Fred",
      "country": "US",
      "area": {
        "id": "489ce91b-6658-3307-9877-795b68554c98",
        "name": "United States",
        "sort-name": "United States"
      },
      "life-span": {
        "ended": null
      }
    }
  ]
} as const;

export const publishedRecordingSearch = {
  "created": "2017-02-23T14:31:36.889Z",
  "count": 1,
  "offset": 0,
  "recordings": [
    {
      "id": "026fa041-3917-4c73-9079-ed16e36f20f8",
      "score": "100",
      "title": "Blow Your Mind (Mwah)",
      "length": 178000,
      "video": null,
      "artist-credit": [
        {
          "artist": {
            "id": "6f1a58bf-9b1b-49cf-a44a-6cefad7ae04f",
            "name": "Dua Lipa",
            "sort-name": "Lipa, Dua"
          }
        }
      ],
      "artist-credit-id": "4af83e24-f886-35c8-831f-5dde0163a6a0",
      "first-release-date": "2016-08-26",
      "releases": [
        {
          "id": "383be31c-37a0-4e08-8cda-cbcbbc587ae5",
          "title": "Blow Your Mind (Mwah)",
          "status-id": "4e304316-386d-3409-af2e-78857eec5cfe",
          "status": "Official",
          "release-group": {
            "id": "4a45bfa5-eb1e-49eb-a20c-1021389b2121",
            "primary-type": "Single"
          },
          "date": "2016-08-26",
          "country": "XW",
          "release-events": [
            {
              "date": "2016-08-26",
              "area": {
                "id": "525d4e18-3d00-31b9-a58b-a146a916de8f",
                "name": "[Worldwide]",
                "sort-name": "[Worldwide]",
                "iso-3166-1-codes": [
                  "XW"
                ]
              }
            }
          ],
          "track-count": 1,
          "media": [
            {
              "position": 1,
              "format": "Digital Media",
              "track": [
                {
                  "id": "0ef6e647-4aeb-438e-8c8a-50c22c511203",
                  "number": "1",
                  "title": "Blow Your Mind (Mwah)",
                  "length": 179000
                }
              ],
              "track-count": 1,
              "track-offset": 0
            }
          ]
        }
      ],
      "isrcs": [
        {
          "id": "GBAHT1600302"
        },
        {
          "id": "GBAHT1600331"
        }
      ],
      "tags": [
        {
          "count": 1,
          "name": "electropop"
        },
        {
          "count": 1,
          "name": "dance-pop"
        },
        {
          "count": 1,
          "name": "contemporary r&b"
        }
      ]
    }
  ]
} as const;

export const publishedReleaseGroupSearch = {
  "created": "2017-03-12T17:27:52.777Z",
  "count": 1,
  "offset": 0,
  "release-groups": [
    {
      "id": "70664047-2545-4e46-b75f-4556f2a7b83e",
      "score": "100",
      "count": 1,
      "title": "Main Tenance",
      "first-release-date": "1998",
      "primary-type": "Single",
      "artist-credit": [
        {
          "artist": {
            "id": "a8fa58d8-f60b-4b83-be7c-aea1af11596b",
            "name": "Fred Giannelli",
            "sort-name": "Giannelli, Fred",
            "disambiguation": "US electronic artist",
            "aliases": [
              {
                "sort-name": "Fred",
                "name": "Fred",
                "locale": null,
                "type": null,
                "primary": null,
                "begin-date": null,
                "end-date": null
              },
              {
                "sort-name": "Giannelli, Fred Domenic, II",
                "name": "Fred Domenic Giannelli II",
                "locale": null,
                "type": "Legal name",
                "primary": null,
                "begin-date": null,
                "end-date": null
              },
              {
                "sort-name": "Fred Gianelli",
                "name": "Fred Gianelli",
                "locale": null,
                "type": null,
                "primary": null,
                "begin-date": null,
                "end-date": null
              }
            ]
          }
        }
      ],
      "artist-credit-id": "ce1e40a1-048d-3ffb-afd7-c9d6eb6984c5",
      "releases": [
        {
          "id": "9168f4cc-a852-4ba5-bf85-602996625651",
          "title": "Main Tenance",
          "status": "Official"
        }
      ]
    }
  ]
} as const;
