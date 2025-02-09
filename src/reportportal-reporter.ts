import Mocha from 'mocha'
import { ReportportalParallelRunAgent } from './reportportal-parallel-run-agent'
const ReportportalAgent = require('@reportportal/agent-js-mocha/lib/mochaReporter')

export class ReportportalReporter extends Mocha.reporters.Base {
  constructor(runner, options) {
    super(runner, options)
    if (options.parallel === true) {
      process.env.RETURNLY_REPORTPORTAL_PARALLEL = 'true'
      return new ReportportalParallelRunAgent(
        runner,
        options
      ) as unknown as Mocha.reporters.Base
    } else {
      process.env.RETURNLY_REPORTPORTAL_PARALLEL = 'false'
      return new ReportportalAgent(runner, options)
    }
  }
}
