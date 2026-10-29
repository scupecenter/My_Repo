-- Messages (ADR 0013). Only the two participants of a thread can read or reply to it, even a System Admin cannot read a thread
-- they are not part of, and nobody can change a message after it was sent. Thread T_ALICE_BOB is Alice and Bob; Carol is
-- not part of it.

-- @case MS-01
-- @title Carol counts the messages of Alice's thread
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT count(*) FROM messages WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-02
-- @title Carol looks up the thread row
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT count(*) FROM message_threads WHERE id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-03
-- @title Carol lists the participants of Alice's thread
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT count(*) FROM message_participants WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-04
-- @title Carol replies in Alice's thread
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect error 42501 not a participant of this thread
SELECT msg_reply('{{T_ALICE_BOB}}', 'Injected reply');
-- @end

-- @case MS-05
-- @title Carol starts a thread with Alice, who is neither her manager nor her report
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect error 42501 you can message your direct manager
SELECT msg_start('{{ALICE}}', 'Unsolicited', 'Hello');
-- @end

-- @case MS-06
-- @title Carol marks Alice's thread as read: no participant row is created for her
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT msg_mark_read('{{T_ALICE_BOB}}');
SELECT count(*) FROM message_participants WHERE thread_id = '{{T_ALICE_BOB}}' AND user_id = '{{CAROL}}';
-- @end

-- @case MS-07
-- @title Alice (a participant) edits a message she already sent
-- @category messages
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE messages SET body = 'Changed after sending' WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-08
-- @title Alice (a participant) deletes the messages of her thread
-- @category messages
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM messages WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-09
-- @title The System Admin counts the messages of a thread he is not part of
-- @category messages
-- @actor ADMIN
-- @region *
-- @expect output 0
SELECT count(*) FROM messages WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case MS-10
-- @title The System Admin replies in a thread he is not part of
-- @category messages
-- @actor ADMIN
-- @region *
-- @expect error 42501 not a participant of this thread
SELECT msg_reply('{{T_ALICE_BOB}}', 'Admin injects');
-- @end

-- @case MS-11
-- @title Alice starts a thread with Carol, who is not her manager or report
-- @category messages
-- @actor ALICE
-- @region 1
-- @expect error 42501 you can message your direct manager
SELECT msg_start('{{CAROL}}', 'Unsolicited', 'Hello');
-- @end

-- @case MS-12
-- @title Carol lists who participates in any thread that includes Alice
-- @category messages
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT count(*) FROM message_participants WHERE user_id = '{{ALICE}}';
-- @end
