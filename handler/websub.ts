// The two endpoints of the hub.
import { getConfig } from '../lib/config';
import { LogContext } from '../lib/log';
import { checkCallback, checkFeedId, checkLeaseSeconds, checkMode, checkSecret, checkToken, checkTopic } from '../lib/params';
import { notify } from '../lib/publish';
import { IncomingHttpRequest } from '../lib/server-common';
import { requestSubscription } from '../lib/subscriptions';

// POST /websub/subscribe/:feed (form-encoded hub.mode, hub.topic, hub.callback, hub.lease_seconds, hub.secret).
// 202 if the request is accepted; the subscription is then verified asynchronously.
export async function subscribeHandler(log: LogContext, event: IncomingHttpRequest) {
    const config = getConfig();
    const feed = checkFeedId(config, event.pathParameters.feed);
    const body = event.body && typeof event.body == 'object' ? event.body : {};
    const mode = checkMode(body['hub.mode']);
    const topic = checkTopic(feed, body['hub.topic']);
    const { callback, host } = checkCallback(config, body['hub.callback']);
    const leaseSeconds = checkLeaseSeconds(config.limits, body['hub.lease_seconds']);
    const secret = mode == 'subscribe' ? checkSecret(config, body['hub.secret']) : undefined;
    requestSubscription({ feed, mode, topic, callback, host, leaseSeconds, ...(secret !== undefined ? { secret } : {}) });
    log.info('Accepted {0} of {1} to {2}', mode, callback, topic);
    event.responseStatus = 202;
    return { status: 'pending' };
}

// POST /websub/notification/:token: the publisher reports that its feed was updated. 202; the feed is
// checked after notifyDelaySeconds.
export async function notificationHandler(log: LogContext, event: IncomingHttpRequest) {
    const feed = checkToken(getConfig(), event.pathParameters.token);
    const status = notify(feed);
    log.info('Notification for feed {0}: {1}', feed.id, status);
    event.responseStatus = 202;
    return { status };
}
