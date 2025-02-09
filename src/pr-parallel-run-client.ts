/* eslint-disable quotes,no-console,class-methods-use-this */
import { ClientHelpers } from './client-helpers'
import { ParallelRestClient } from './parallel-rest-client'
import { Log, LogComponent } from '@rtly-sdet/logger'

const UniqId = require('uniqid')
const helpers = require('@reportportal/client-javascript/lib/helpers')
const Analytics = require('@reportportal/client-javascript/analytics/analytics')
const {
  RP_STATUSES,
} = require('@reportportal/client-javascript/lib/constants/statuses')
const {
  CLIENT_JAVASCRIPT_EVENTS,
  getAgentEventLabel,
} = require('@reportportal/client-javascript/analytics/events')

const log: Log = new Log(LogComponent.SDET_RUNNER)
const MULTIPART_BOUNDARY = Math.floor(Math.random() * 10000000000).toString()

export class PrParallelRunClient {
  private debug: boolean
  private isLaunchMergeRequired: any
  public map: {}
  private baseURL: string
  private baseLaunchURL: string
  private headers: Record<string, string>
  private token: string
  private config: any
  private helpers: ClientHelpers
  private restClient: any
  private analytics: any
  private launchUuid: string
  private nonRetriedItemMap: Map<any, any>

  /**
   * Create a client for RP.
   * @param {Object} params - config object.
   * params should look like this
   * {
   *      token: "00000000-0000-0000-0000-000000000000",
   *      endpoint: "http://localhost:8080/api/v1",
   *      launch: "YOUR LAUNCH NAME",
   *      project: "PROJECT NAME",
   * }
   *
   * @param {Object} agentParams - agent's info object.
   * agentParams should look like this
   * {
   *     name: "AGENT NAME",
   *     version: "AGENT VERSION",
   * }
   */
  constructor(params, agentParams) {
    this.debug = params.debug
    this.isLaunchMergeRequired =
      params.isLaunchMergeRequired === undefined
        ? false
        : params.isLaunchMergeRequired
    this.map = {}
    this.baseURL = [params.endpoint, params.project].join('/')
    this.baseLaunchURL = [
      `${new URL(params.endpoint).protocol}/`,
      `${new URL(params.endpoint).hostname}:${new URL(params.endpoint).port}`,
      'ui',
      `#${params.project}`,
      'launches',
      'all',
    ].join('/')
    this.headers = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'User-Agent': 'NodeJS',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      Authorization: `bearer ${params.token}`,
      ...(params.headers || {}),
    }
    this.token = params.token
    this.config = params
    this.helpers = new ClientHelpers()
    this.restClient = new ParallelRestClient({
      baseURL: this.baseURL,
      headers: this.headers,
      restClientConfig: params.restClientConfig,
    })
    this.analytics = new Analytics(agentParams)
    this.launchUuid = ''
    this.nonRetriedItemMap = new Map()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   *
   * @Private
   */
  logDebug(msg) {
    if (this.debug) {
      log.debug(msg)
    }
  }

  calculateNonRetriedItemMapKey(launchId, parentId, name, itemId = '') {
    return `${launchId}__${parentId}__${name}__${itemId}`
  }

  getUniqId() {
    return UniqId()
  }

  getRejectAnswer(tempId, error) {
    return {
      tempId,
      promise: Promise.reject(error),
    }
  }

  getNewItemObj(startPromiseFunc) {
    let resolveFinish
    let rejectFinish
    const obj = {
      promiseStart: new Promise(startPromiseFunc),
      realId: '',
      children: [],
      finishSend: false,
      promiseFinish: new Promise((resolve, reject) => {
        resolveFinish = resolve
        rejectFinish = reject
      }),
      resolveFinish: undefined,
      rejectFinish: undefined,
    }
    obj.resolveFinish = resolveFinish
    obj.rejectFinish = rejectFinish
    return obj
  }

  triggerAnalyticsEvent() {
    if (process.env.REPORTPORTAL_CLIENT_JS_NO_ANALYTICS) {
      return
    }

    if (this.analytics.agentParams) {
      const label = getAgentEventLabel(this.analytics.agentParams)
      this.analytics.trackEvent(
        Object.assign(CLIENT_JAVASCRIPT_EVENTS.START_LAUNCH, { label })
      )
    } else {
      this.analytics.trackEvent(CLIENT_JAVASCRIPT_EVENTS.START_LAUNCH)
    }
  }

  /**
   * Start launch and report it.
   * @param {Object} launchDataRQ - request object.
   * launchDataRQ should look like this
   * {
            "description": "string" (support markdown),
            "mode": "DEFAULT" or "DEBUG",
            "name": "string",
            "startTime": this.helper.now(),
            "attributes": [
                {
                    "key": "string",
                    "value": "string"
                },
                {
                    "value": "string"
                }
            ]
   * }
   * @Returns an object which contains a tempID and a promise
   *
   * As system attributes, this method sends the following data (these data are not for public use):
   * client name, version;
   * agent name, version (if given);
   * browser name, version (if given);
   * OS type, architecture;
   * RAMSize;
   * nodeJS version;
   *
   * This method works in two ways:
   * First - If launchDataRQ object doesn't contain ID field,
   * it would create a new Launch instance at the Report Portal with it ID.
   * Second - If launchDataRQ would contain ID field,
   * client would connect to the existing Launch which ID
   * has been sent , and would send all data to it.
   * Notice that Launch which ID has been sent must be 'IN PROGRESS' state at the Report Portal
   * or it would throw an error.
   * @Returns {Object} - an object which contains a tempID and a promise
   */
  startLaunch(launchDataRQ) {
    const tempId = this.getUniqId()

    if (launchDataRQ.id) {
      this.map[tempId] = this.getNewItemObj((resolve) => resolve(launchDataRQ))
      this.map[tempId].realId = launchDataRQ.id
      this.launchUuid = launchDataRQ.id
    } else {
      const systemAttr = helpers.getSystemAttribute()
      const attributes = Array.isArray(launchDataRQ.attributes)
        ? launchDataRQ.attributes.concat(systemAttr)
        : systemAttr
      const launchData = {
        name: this.config.launch || 'Test launch name',
        startTime: this.helpers.now(),
        ...launchDataRQ,
        attributes,
      }

      this.map[tempId] = this.getNewItemObj((resolve, reject) => {
        const url = 'launch'
        this.logDebug(`Start launch ${tempId}`)
        this.restClient.create(url, launchData, { headers: this.headers }).then(
          (response) => {
            this.map[tempId].realId = response.id
            this.map[tempId].launchNumber = response.number
            this.launchUuid = response.id
            this.printLaunchURL(this.launchUuid)
            if (this.isLaunchMergeRequired) {
              helpers.saveLaunchIdToFile(response.id)
            }
            resolve(response)
          },
          (error) => {
            console.dir(error)
            reject(error)
          }
        )
      })
    }
    this.triggerAnalyticsEvent()
    return {
      tempId,
      promise: this.map[tempId].promiseStart,
    }
  }

  printLaunchURL(id: string) {
    const url = ['launch', 'uuid', id].join('/')

    this.restClient.retrieve(url, { headers: this.headers }).then(
      (response) => {
        log.info(
          `Report Portal Launch Link: ${this.baseLaunchURL}/${response.id}`
        )
      },
      (error) => {
        log.error(error)
      }
    )
  }

  /**
   * Finish launch.
   * @param {string} launchTempId - temp launch id (returned in the query "startLaunch").
   * @param {Object} finishExecutionRQ - finish launch info should include time and status.
   * finishExecutionRQ should look like this
   * {
   *      "endTime": this.helper.now(),
   *      "status": "passed" or one of ‘passed’, ‘failed’, ‘stopped’, ‘skipped’, ‘interrupted’, ‘cancelled’
   * }
   * @Returns {Object} - an object which contains a tempID and a promise
   */
  finishLaunch(launchTempId, finishExecutionRQ) {
    const launchObj = this.map[launchTempId]
    if (!launchObj) {
      return this.getRejectAnswer(
        launchTempId,
        new Error(`Launch "${launchTempId}" not found`)
      )
    }

    const finishExecutionData = {
      endTime: this.helpers.now(),
      ...finishExecutionRQ,
    }

    launchObj.finishSend = true
    Promise.all(
      launchObj.children.map((itemId) => this.map[itemId].promiseFinish)
    ).then(
      () => {
        launchObj.promiseStart.then(
          () => {
            this.logDebug(`Finish launch ${launchTempId}`)
            const url = ['launch', launchObj.realId, 'finish'].join('/')
            this.restClient
              .update(url, finishExecutionData, { headers: this.headers })
              .then(
                (response) => {
                  this.logDebug(`Success finish launch ${launchTempId}`)
                  launchObj.resolveFinish(response)
                },
                (error) => {
                  this.logDebug(`Error finish launch ${launchTempId}`)
                  console.dir(error)
                  launchObj.rejectFinish(error)
                }
              )
          },
          (error) => {
            launchObj.rejectFinish(error)
          }
        )
      },
      (error) => {
        launchObj.rejectFinish(error)
      }
    )

    return {
      tempId: launchTempId,
      promise: launchObj.promiseFinish,
    }
  }

  updateLaunch(launchTempId, launchData) {
    const launchObj = this.map[launchTempId]
    if (!launchObj) {
      return this.getRejectAnswer(
        launchTempId,
        new Error(`Launch "${launchTempId}" not found`)
      )
    }
    let resolvePromise
    let rejectPromise
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    launchObj.promiseFinish.then(
      () => {
        const url = ['launch', launchObj.realId, 'update'].join('/')
        this.restClient.update(url, launchData, { headers: this.headers }).then(
          (response) => {
            resolvePromise(response)
          },
          (error) => {
            rejectPromise(error)
          }
        )
      },
      (error) => {
        rejectPromise(error)
      }
    )
    return {
      tempId: launchTempId,
      promise,
    }
  }

  /**
   * If there is no parentItemId starts Suite, else starts test or item.
   * @param {Object} testItemDataRQ - object with item parameters
   * testItemDataRQ should look like this
   * {
            "description": "string" (support markdown),
            "name": "string",
            "startTime": this.helper.now(),
            "attributes": [
                {
                    "key": "string",
                    "value": "string"
                },
                {
                    "value": "string"
                }
            ],
            "type": 'SUITE' or one of 'SUITE', 'STORY', 'TEST',
                    'SCENARIO', 'STEP', 'BEFORE_CLASS', 'BEFORE_GROUPS',
                    'BEFORE_METHOD', 'BEFORE_SUITE', 'BEFORE_TEST',
                    'AFTER_CLASS', 'AFTER_GROUPS', 'AFTER_METHOD',
                    'AFTER_SUITE', 'AFTER_TEST'
        }
   * @param {string} launchTempId - temp launch id (returned in the query "startLaunch").
   * @param {string} parentTempId (optional) - temp item id (returned in the query "startTestItem").
   * @Returns {Object} - an object which contains a tempId and a promise
   */
  startTestItem(testItemDataRQ, launchTempId, parentTempId) {
    let parentMapId = launchTempId
    const launchObj = this.map[launchTempId]
    if (!launchObj) {
      return this.getRejectAnswer(
        launchTempId,
        new Error(`Launch "${launchTempId}" not found`)
      )
    }
    if (launchObj.finishSend) {
      log.error(`startTestItem error: ${testItemDataRQ}`)
      const err = new Error(
        `Launch "${launchTempId}" is already finished, you can not add an item to it`
      )
      return this.getRejectAnswer(launchTempId, err)
    }

    const testCaseId =
      testItemDataRQ.testCaseId ||
      helpers.generateTestCaseId(
        testItemDataRQ.codeRef,
        testItemDataRQ.parameters
      )
    const testItemData = {
      startTime: this.helpers.now(),
      ...testItemDataRQ,
      ...(testCaseId && { testCaseId }),
    }

    let parentPromise = launchObj.promiseStart
    if (parentTempId) {
      parentMapId = parentTempId
      const parentObj = this.map[parentTempId]
      if (!parentObj) {
        return this.getRejectAnswer(
          launchTempId,
          new Error(`Item "${parentTempId}" not found`)
        )
      }
      parentPromise = parentObj.promiseStart
    }

    const itemKey = this.calculateNonRetriedItemMapKey(
      launchTempId,
      parentTempId,
      testItemDataRQ.name,
      testItemDataRQ.uniqueId
    )
    const firstNonRetriedItemPromise =
      testItemDataRQ.retry && this.nonRetriedItemMap.get(itemKey)
    if (firstNonRetriedItemPromise) {
      parentPromise = Promise.all([parentPromise, firstNonRetriedItemPromise])
    }

    const tempId = this.getUniqId()
    this.map[tempId] = this.getNewItemObj((resolve, reject) => {
      parentPromise.then(
        () => {
          const realLaunchId = this.map[launchTempId].realId
          let url = 'item/'
          if (parentTempId) {
            const realParentId = this.map[parentTempId].realId
            url += `${realParentId}`
          }
          testItemData.launchUuid = realLaunchId
          this.logDebug(`Start test item ${tempId}`)
          this.restClient
            .create(url, testItemData, { headers: this.headers })
            .then(
              (response) => {
                this.logDebug(
                  `Success start item ${tempId}, realId:  ${response.id}`
                )
                this.map[tempId].realId = response.id
                this.nonRetriedItemMap.delete(itemKey)
                resolve(response)
              },
              (error) => {
                this.logDebug(`Error start item ${tempId}:`)
                console.dir(error)
                reject(error)
              }
            )
        },
        (error) => {
          reject(error)
        }
      )
    })
    this.map[tempId].startTime = testItemDataRQ.startTime
    this.map[parentMapId].children.push(tempId)

    if (!testItemDataRQ.retry) {
      this.nonRetriedItemMap.set(itemKey, this.map[tempId].promiseStart)
    }

    return {
      tempId,
      promise: this.map[tempId].promiseStart,
    }
  }

  /**
   * Finish Suite or Step level.
   * @param {string} itemTempId - temp item id (returned in the query "startTestItem").
   * @param {Object} finishTestItemRQ - object with item parameters.
   * finishTestItemRQ should look like this
   {
        "endTime": this.helper.now(),
        "issue": {
          "comment": "string",
          "externalSystemIssues": [
            {
              "submitDate": 0,
              "submitter": "string",
              "systemId": "string",
              "ticketId": "string",
              "url": "string"
            }
          ],
          "issueType": "string"
        },
        "status": "passed" or one of 'passed', 'failed', 'stopped', 'skipped', 'interrupted', 'cancelled'
     }
   * @Returns {Object} - an object which contains a tempId and a promise
   */
  finishTestItem(itemTempId, finishTestItemRQ) {
    const itemObj = this.map[itemTempId]
    if (!itemObj) {
      return this.getRejectAnswer(
        itemTempId,
        new Error(`Item "${itemTempId}" not found`)
      )
    }

    const finishTestItemData = {
      endTime: this.helpers.now(),
      ...(itemObj.children.length ? {} : { status: RP_STATUSES.PASSED }),
      ...finishTestItemRQ,
    }

    itemObj.finishSend = true
    Promise.all(
      itemObj.children.map(
        (itemId) => this.map[itemId] && this.map[itemId].promiseFinish
      )
    ).then(
      () => {
        this.finishTestItemPromiseStart(
          itemObj,
          itemTempId,
          Object.assign(finishTestItemData, { launchUuid: this.launchUuid })
        )
      },
      () => {
        this.logDebug(`Error finish children of test item ${itemTempId}`)
        this.logDebug(`Finish test item ${itemTempId}`)
        this.finishTestItemPromiseStart(
          itemObj,
          itemTempId,
          Object.assign(finishTestItemData, { launchUuid: this.launchUuid })
        )
      }
    )

    return {
      tempId: itemTempId,
      promise: itemObj.promiseFinish,
    }
  }

  saveLog(itemObj, requestPromiseFunc) {
    const tempId = this.getUniqId()
    this.map[tempId] = this.getNewItemObj((resolve, reject) => {
      itemObj.promiseStart.then(
        () => {
          this.logDebug(`Save log ${tempId}`)
          requestPromiseFunc(itemObj.realId, this.launchUuid).then(
            (response) => {
              this.logDebug(`Successfully save log ${tempId}`)
              resolve(response)
            },
            (error) => {
              this.logDebug(`Error finish log: ${error}`)
              reject(error)
            }
          )
        },
        (error) => {
          reject(error)
        }
      )
    })
    itemObj.children.push(tempId)

    const logObj = this.map[tempId]
    logObj.finishSend = true
    logObj.promiseStart.then(
      (response) => logObj.resolveFinish(response),
      (error) => logObj.rejectFinish(error)
    )

    return {
      tempId,
      promise: this.map[tempId].promiseFinish,
    }
  }

  sendLog(itemTempId, saveLogRQ, fileObj) {
    const saveLogData = {
      time: this.helpers.now(),
      message: '',
      level: '',
      ...saveLogRQ,
    }

    if (fileObj) {
      return this.sendLogWithFile(itemTempId, saveLogData, fileObj)
    }
    return this.sendLogWithoutFile(itemTempId, saveLogData)
  }

  /**
   * Send log of test results.
   * @param {string} itemTempId - temp item id (returned in the query "startTestItem").
   * @param {Object} saveLogRQ - object with data of test result.
   * saveLogRQ should look like this
   * {
   *      level: 'error' or one of 'trace', 'debug', 'info', 'warn', 'error', '',
   *      message: 'string' (support markdown),
   *      time: this.helpers.now()
   * }
   * @Returns {Object} - an object which contains a tempId and a promise
   */
  sendLogWithoutFile(itemTempId, saveLogRQ) {
    const itemObj = this.map[itemTempId]
    if (!itemObj) {
      return this.getRejectAnswer(
        itemTempId,
        new Error(`Item "${itemTempId}" not found`)
      )
    }

    const requestPromise = (itemUuid, launchUuid) => {
      const url = 'log'
      const isItemUuid = itemUuid !== launchUuid
      return this.restClient.create(
        url,
        Object.assign(saveLogRQ, { launchUuid }, isItemUuid && { itemUuid }),
        { headers: this.headers }
      )
    }
    return this.saveLog(itemObj, requestPromise)
  }

  /**
   * Send log of test results with file.
   * @param {string} itemTempId - temp item id (returned in the query "startTestItem").
   * @param {Object} saveLogRQ - object with data of test result.
   * saveLogRQ should look like this
   * {
   *      level: 'error' or one of 'trace', 'debug', 'info', 'warn', 'error', '',
   *      message: 'string' (support markdown),
   *      time: this.helpers.now()
   * }
   * @param {Object} fileObj - object with file data.
   * fileObj should look like this
   * {
          name: 'string',
          type: "image/png" or your file mimeType
            (supported types: 'image/*', application/ ['xml', 'javascript', 'json', 'css', 'php'],
            another format will be opened in a new browser tab ),
          content: file
   * }
   * @Returns {Object} - an object which contains a tempId and a promise
   */
  sendLogWithFile(itemTempId, saveLogRQ, fileObj) {
    const itemObj = this.map[itemTempId]
    if (!itemObj) {
      return this.getRejectAnswer(
        itemTempId,
        new Error(`Item "${itemTempId}" not found`)
      )
    }
    // eslint-disable-next-line max-len
    const requestPromise = (itemUuid, launchUuid) => {
      const isItemUuid = itemUuid !== launchUuid

      // eslint-disable-next-line max-len
      return this.getRequestLogWithFile(
        Object.assign(saveLogRQ, { launchUuid }, isItemUuid && { itemUuid }),
        fileObj
      )
    }

    return this.saveLog(itemObj, requestPromise)
  }

  getRequestLogWithFile(saveLogRQ, fileObj) {
    const url = 'log'
    // eslint-disable-next-line no-param-reassign
    saveLogRQ.file = { name: fileObj.name }
    return this.restClient
      .create(
        url,
        this.buildMultiPartStream([saveLogRQ], fileObj, MULTIPART_BOUNDARY),
        {
          headers: {
            ...this.headers,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Content-Type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
          },
        }
      )
      .then((response) => response)
      .catch((error) => {
        this.logDebug('ERROR')
        this.logDebug(error)
      })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   *
   * @Private
   */
  buildMultiPartStream(jsonPart, filePart, boundary) {
    const eol = '\r\n'
    const bx = `--${boundary}`
    const buffers = [
      // eslint-disable-next-line function-paren-newline
      Buffer.from(
        // eslint-disable-next-line prefer-template
        bx +
          eol +
          'Content-Disposition: form-data; name="json_request_part"' +
          eol +
          'Content-Type: application/json' +
          eol +
          eol +
          eol +
          JSON.stringify(jsonPart) +
          eol
      ),
      // eslint-disable-next-line function-paren-newline
      Buffer.from(
        // eslint-disable-next-line prefer-template
        bx +
          eol +
          'Content-Disposition: form-data; name="file"; filename="' +
          filePart.name +
          '"' +
          eol +
          'Content-Type: ' +
          filePart.type +
          eol +
          eol
      ),
      Buffer.from(filePart.content, 'base64'),
      Buffer.from(`${eol + bx}--${eol}`),
    ]
    return Buffer.concat(buffers)
  }

  finishTestItemPromiseStart(itemObj, itemTempId, finishTestItemData) {
    itemObj.promiseStart.then(
      () => {
        const url = ['item', itemObj.realId].join('/')
        this.logDebug(`Finish test item ${itemTempId}`)
        // eslint-disable-next-line max-len
        this.restClient
          .update(
            url,
            Object.assign(finishTestItemData, { launchUuid: this.launchUuid }),
            {
              headers: this.headers,
            }
          )
          .then(
            (response) => {
              this.logDebug(`Success finish item ${itemTempId}`)
              itemObj.resolveFinish(response)
              itemObj.finishCompleted = true
            },
            (error) => {
              this.logDebug(`Error finish test item ${itemTempId}`)
              console.dir(error)
              itemObj.rejectFinish(error)
            }
          )
      },
      (error) => {
        itemObj.rejectFinish(error)
      }
    )
  }
}
