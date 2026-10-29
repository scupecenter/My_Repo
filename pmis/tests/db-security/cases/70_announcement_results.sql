-- Announcements (ADR 0013). A recipient answers once, and sees only their own answer. Results (other people's answers, notes
-- and recipients) are for the sender and the System Admins. Notice A went to Alice and Carol (Alice agreed, Carol disagreed
-- with a note). Notice B went to Carol only. Notice C went to Alice and Carol and nobody has answered it.

-- @case AR-01
-- @title Alice counts the answers of other people to notice A
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM announcement_responses WHERE announcement_id = '{{ANN_A}}' AND user_id <> '{{ALICE}}';
-- @end

-- @case AR-02
-- @title Carol counts the answers of other people to notice A
-- @category announcement-results
-- @actor CAROL
-- @region 1
-- @expect output 0
SELECT count(*) FROM announcement_responses WHERE announcement_id = '{{ANN_A}}' AND user_id <> '{{CAROL}}';
-- @end

-- @case AR-03
-- @title Alice lists the other recipients of notice A
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM announcement_recipients WHERE announcement_id = '{{ANN_A}}' AND user_id <> '{{ALICE}}';
-- @end

-- @case AR-04
-- @title Alice reads the target list of notice A
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM announcement_targets WHERE announcement_id = '{{ANN_A}}';
-- @end

-- @case AR-05
-- @title Alice asks whether she may read the results of notice A
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect output f
SELECT ann_can_read_results('{{ANN_A}}');
-- @end

-- @case AR-06
-- @title Alice opens notice B, which was not sent to her
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM announcements WHERE id = '{{ANN_B}}';
-- @end

-- @case AR-07
-- @title Alice answers notice A a second time (answers are final)
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect error 23505 duplicate key
SELECT ann_respond('{{ANN_A}}', 'disagree', 'Changing my mind');
-- @end

-- @case AR-08
-- @title Alice answers notice B, which was not sent to her
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect error 42501 this announcement is not addressed to you
SELECT ann_respond('{{ANN_B}}', 'agree', NULL);
-- @end

-- @case AR-09
-- @title Alice disagrees with notice C without a note
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect error 23514 announcement_disagree_needs_note
SELECT ann_respond('{{ANN_C}}', 'disagree', NULL);
-- @end

-- @case AR-10
-- @title Alice disagrees with notice C with a note shorter than three characters
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect error 23514 announcement_disagree_needs_note
SELECT ann_respond('{{ANN_C}}', 'disagree', 'ab');
-- @end

-- @case AR-11
-- @title Alice rewrites Carol's answer to notice A
-- @category announcement-results
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE announcement_responses SET decision = 'agree', note = NULL WHERE announcement_id = '{{ANN_A}}' AND user_id = '{{CAROL}}';
-- @end

-- @case AR-12
-- @title Carol deletes her own answer to notice A
-- @category announcement-results
-- @actor CAROL
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM announcement_responses WHERE announcement_id = '{{ANN_A}}' AND user_id = '{{CAROL}}';
-- @end
