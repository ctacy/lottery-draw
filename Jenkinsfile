// 年会抽奖：测试 → 打包 → SSH 发布到目标服务器（systemd + 软链切换，健康检查失败自动回滚）
// 前置条件见 README「Jenkins 部署」
pipeline {
  agent any

  options {
    timeout(time: 15, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    string(name: 'DEPLOY_HOST', defaultValue: '', description: '目标服务器，如 deploy@10.0.0.5；留空则只测试不部署')
  }

  environment {
    APP_ROOT = '/opt/lottery'
    SSH_CREDENTIALS = 'lottery-deploy-ssh'
  }

  stages {
    stage('Install') {
      steps {
        sh 'node -v && npm ci --no-audit --no-fund'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }

    stage('Package') {
      steps {
        // 只打包已入库文件，天然排除 node_modules / data / .env
        sh 'git archive --format=tar.gz -o lottery.tgz HEAD'
        archiveArtifacts artifacts: 'lottery.tgz', fingerprint: true
      }
    }

    stage('Deploy') {
      // 多分支流水线只发布 main；普通流水线（无 BRANCH_NAME）按参数决定
      when {
        expression { params.DEPLOY_HOST?.trim() && (env.BRANCH_NAME == null || env.BRANCH_NAME == 'main') }
      }
      steps {
        sshagent(credentials: [env.SSH_CREDENTIALS]) {
          sh '''
            set -eu
            REL="$APP_ROOT/releases/$BUILD_NUMBER-$(git rev-parse --short HEAD)"
            SSH="ssh -o StrictHostKeyChecking=accept-new $DEPLOY_HOST"
            $SSH "mkdir -p '$REL' && tar xzf - -C '$REL'" < lottery.tgz
            $SSH "bash '$REL/deploy/deploy.sh' '$REL'"
          '''
        }
      }
    }
  }

  post {
    always {
      deleteDir()
    }
  }
}
