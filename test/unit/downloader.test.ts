import { startRedis, stopRedis, redisStore } from './bootstrap.js'
import Downloader from '../../src/Downloader.js'
import MediaWiki from '../../src/MediaWiki.js'
import Axios from 'axios'
import { mwRetToArticleDetail, stripHttpFromUrl, isImageUrl } from '../../src/util/index.js'
import S3 from '../../src/S3.js'
import { Dump } from '../../src/Dump'
import { config } from '../../src/config.js'
import 'dotenv/config.js'
import * as FileType from 'file-type'
import { jest } from '@jest/globals'
import urlParser from 'url'
import { setTimeout } from 'timers/promises'

jest.setTimeout(100000)

describe('Downloader class', () => {
  let mw: MediaWiki
  let downloader: Downloader

  beforeAll(startRedis)
  afterAll(stopRedis)

  beforeAll(async () => {
    mw = new MediaWiki({
      base: 'https://en.wikipedia.org',
      getCategories: true,
    } as any)

    downloader = new Downloader({ mw, uaString: `${config.userAgent} (contact@kiwix.org)`, speed: 1, reqTimeout: 1000 * 60, webp: true, optimisationCacheUrl: '' })

    await mw.getMwMetaData(downloader)
    await downloader.checkCapabilities()
    await downloader.setBaseUrls()
  })

  test('downloader.query returns valid JSON', async () => {
    const queryRet = await downloader.query('?action=query&meta=siteinfo&siprop=statistics&format=json')
    expect(queryRet).toBeDefined()
  })

  test('downloader.getJSON returns valid JSON', async () => {
    const JSONRes = await downloader.getJSON('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json')
    expect(JSONRes).toBeDefined()
  })

  test('downloader.canGetUrl returns valid answer (positive)', async () => {
    const urlExists = await downloader.canGetUrl('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json')
    expect(urlExists).toBeDefined()
  })

  test('downloader.canGetUrl returns valid answer (negative)', async () => {
    const urlNotExists = await downloader.canGetUrl('https://en.wikipedia.org/w/thisisa404')
    expect(urlNotExists).toBeDefined()
  })

  test('getJSON response status for non-existant url is 404', async () => {
    await expect(downloader.getJSON('https://en.wikipedia.org/w/thisisa404')).rejects.toThrowError(new Error('Request failed with status code 404'))
  })

  test('downloader.downloadContent returns', async () => {
    const contentRes = await downloader.downloadContent('https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/London_Montage_L.jpg/275px-London_Montage_L.jpg')
    expect(contentRes.responseHeaders).toBeDefined()
  })

  test('Webp compression working for cmyk color-space images', async () => {
    const { content } = await downloader.downloadContent('https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/LOGO_HAEMMERLIN.jpg/550px-LOGO_HAEMMERLIN.jpg')
    const fileType = await FileType.fileTypeFromBuffer(Buffer.from(content))
    expect(fileType?.mime).toEqual('image/webp')
  })

  test('downloader.downloadContent throws on non-existant url', async () => {
    await expect(downloader.downloadContent('https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/thisdoesnotexist.jpg')).rejects.toThrowError(
      new Error('Request failed with status code 404'),
    )
  })

  test("getArticleDetailsIds Scraped 'London', 'United_Kingdom', 'Paris', 'Zürich', 'THISARTICLEDOESNTEXIST' successfully", async () => {
    const _articleDetailsRet = await downloader.getArticleDetailsIds(['London', 'United_Kingdom', 'Paris', 'Zürich', 'THISARTICLEDOESNTEXIST', 'Category:Container_categories'])
    const articleDetailsRet = mwRetToArticleDetail(_articleDetailsRet)
    redisStore.articleDetailXId.setMany(articleDetailsRet)
    const { London, Paris, Zürich, United_Kingdom, THISARTICLEDOESNTEXIST } = articleDetailsRet
    expect(London).toBeDefined()
    expect(United_Kingdom).toBeDefined()
    expect(Paris).toBeDefined()
    expect(Zürich).toBeDefined()

    expect(THISARTICLEDOESNTEXIST.missing).toBe('')
  })

  test("getArticleDetailsNS query returns 'gapContinue' or 'multiple articles', ", async () => {
    const { gapContinue, articleDetails } = await downloader.getArticleDetailsNS(0)
    expect(gapContinue).toBeDefined()
    expect(Object.keys(articleDetails).length).toBeGreaterThan(10)

    const secondNsRet = await downloader.getArticleDetailsNS(0, gapContinue)
    expect(secondNsRet.gapContinue).toBeDefined()
  })

  test('downloadContent throws when empty string is passed', async () => {
    await expect(downloader.downloadContent('')).rejects.toThrowError()
  })

  test('downloadContent successfully downloaded an image', async () => {
    const { data: LondonDetail } = await Axios.get('https://en.wikipedia.org/api/rest_v1/page/mobile-sections/London')
    const [imgToGet] = Object.values(LondonDetail.lead.image.urls)

    const LondonImage = await downloader.downloadContent(imgToGet as string)
    expect(LondonImage.responseHeaders['content-type']).toMatch(/image\//i)
  })

  describe('getArticle method', () => {
    let dump: Dump

    beforeAll(async () => {
      const mwMetadata = await mw.getMwMetaData(downloader)
      dump = new Dump('', {} as any, mwMetadata)
    })

    test('getArticle of "London" returns one article', async () => {
      const LondonArticle = await downloader.getArticle('London', dump, redisStore.articleDetailXId)
      expect(LondonArticle).toHaveLength(1)
    })

    test('Categories with many subCategories are paginated', async () => {
      const PaginatedArticle = await downloader.getArticle('Category:Container_categories', dump, redisStore.articleDetailXId)
      expect(PaginatedArticle.length).toBeGreaterThan(100)
    })

    test('getArticle response status for non-existent article id is 404', async () => {
      await expect(downloader.getArticle('NeverExistingArticle', dump, redisStore.articleDetailXId)).rejects.toThrowError(new Error('Request failed with status code 404'))
    })
  })

  describe('isImageUrl method', () => {
    test('Checked Image type: png', async () => {
      const isPngFile = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.svg.png')
      expect(isPngFile).toBeTruthy()
    })

    test('Checked Image type: jpg', async () => {
      const isJpgFile = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.JPG')
      expect(isJpgFile).toBeTruthy()
    })

    test('Checked Image type: svg', async () => {
      const isSvgFile = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.svg')
      expect(isSvgFile).toBeTruthy()
    })

    test('Checked Image type: jpeg', async () => {
      const isJpegFile = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.JPEG')
      expect(isJpegFile).toBeTruthy()
    })

    test('Checked Image type: gif', async () => {
      const isgifFile = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.gif')
      expect(isgifFile).toBeTruthy()
    })

    test('Checked Image URL with arguments', async () => {
      const isgifFileWithArgs = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.gif?foo=bar')
      expect(isgifFileWithArgs).toBeTruthy()
    })

    test('Url is not image type', async () => {
      const isnotImage = isImageUrl('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json')
      expect(isnotImage).not.toBeTruthy()
    })

    test('Url is empty string', async () => {
      const isEmptyString = isImageUrl('')
      expect(isEmptyString).not.toBeTruthy()
    })

    test('Image Url has no extension', async () => {
      const imageHasNoExtension = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x')
      expect(imageHasNoExtension).not.toBeTruthy()
    })

    test('Image Url extension is undefined', async () => {
      const extensionIsUndefined = isImageUrl('https://bm.wikipedia.org/static/images/project-logos/undefined')
      expect(extensionIsUndefined).not.toBeTruthy()
    })
  })

  const describeIf = process.env.S3_URL ? describe : describe.skip

  describeIf('Downloader class with optimisation', () => {
    let downloader: Downloader
    let s3: S3
    const s3UrlObj = urlParser.parse(`${process.env.S3_URL}`, true)

    beforeAll(async () => {
      const mw = new MediaWiki({
        base: 'https://en.wikipedia.org',
        getCategories: true,
      } as any)

      s3 = new S3(`${s3UrlObj.protocol}//${s3UrlObj.host}/`, {
        bucketName: s3UrlObj.query.bucketName,
        keyId: s3UrlObj.query.keyId,
        secretAccessKey: s3UrlObj.query.secretAccessKey,
      })
      downloader = new Downloader({
        mw,
        uaString: `${config.userAgent} (contact@kiwix.org)`,
        speed: 1,
        reqTimeout: 1000 * 60,
        webp: false,
        optimisationCacheUrl: 'random-string',
        s3,
      })

      await s3.initialise()
    })

    test('Etag Not Present', async () => {
      const etagNotPresent = await downloader.downloadContent('https://en.wikipedia.org/w/extensions/WikimediaBadges/resources/images/badge-silver-star.png?70a8c')
      expect(etagNotPresent.responseHeaders.etag).toBeUndefined()
    })

    test('Delete image from S3', async () => {
      const testImage = 'https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.png'

      // Strip http(s) from url
      const httpOrHttpsRemoved = stripHttpFromUrl(testImage)
      expect(httpOrHttpsRemoved).toBeDefined()

      // Delete the image already present in S3
      await s3.deleteBlob({ Bucket: s3UrlObj.query.bucketName, Key: httpOrHttpsRemoved })

      // Check if image exists after deleting from S3
      const imageNotExists = await s3.downloadBlob(httpOrHttpsRemoved)
      expect(imageNotExists).toBeNull()
    })

    test('Check Etag image flow from S3', async () => {
      // Get an image URL to run the test with
      const randomImage = await getRandomImageUrl()
      const imagePath = stripHttpFromUrl(randomImage)
      await s3.deleteBlob({ Bucket: s3UrlObj.query.bucketName, Key: imagePath })

      // Download the image (and cache it in S3)
      await downloader.downloadContent(randomImage)

      // Async downloadContent(), waiting this is done
      await setTimeout(5000)

      // Check if S3 Etag is like online Etag
      const upstreamResp = await Axios(randomImage)
      const s3Resp = await s3.downloadBlob(imagePath)
      expect(downloader.removeEtagWeakPrefix(`${upstreamResp.headers.etag}`)).toEqual(s3Resp.Metadata.etag)
      expect(upstreamResp.headers['content-type']).toEqual(s3Resp.Metadata.contenttype)

      // Overwrite Image with new Etag to S3
      const newEtag = '686897696a7c876b7e'
      const newContentType = 'application/octet-stream'
      await s3.uploadBlob(imagePath, upstreamResp.data, newEtag, newContentType, '1')
      await setTimeout(10000)

      // Download again to check the Etag has been overwritten properly
      const newS3Resp = await s3.downloadBlob(imagePath)
      expect(newS3Resp.Metadata.etag).toEqual(newEtag)
      expect(newS3Resp.Metadata.contenttype).toEqual(newContentType)

      // Remove Image after test
      await s3.deleteBlob({ Bucket: s3UrlObj.query.bucketName, Key: imagePath })
    })
  })

  async function getRandomImageUrl(): Promise<string> {
    const resp = await Axios(
      'https://commons.wikimedia.org/w/api.php?action=query&generator=random&grnnamespace=6&prop=imageinfo&iiprop=url&formatversion=2&iiurlwidth=100&format=json',
    )
    const url = resp.data.query.pages[0].imageinfo[0].url
    return isImageUrl(url) ? url : getRandomImageUrl()
  }
})
